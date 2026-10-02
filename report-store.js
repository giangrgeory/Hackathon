const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const bucketName = process.env.SUPABASE_STORAGE_BUCKET || "report-photos";
const localReportsFile = path.resolve(
    process.env.LOCAL_REPORTS_FILE || path.join(__dirname, "data", "reports.json")
);
const localPhotosDirectory = path.resolve(
    process.env.LOCAL_REPORTS_PHOTO_DIR || path.join(__dirname, "uploads", "reports")
);

if (Boolean(supabaseUrl) !== Boolean(supabaseKey)) {
    throw new Error("Set both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
}

const supabase = supabaseUrl
    ? createClient(supabaseUrl, supabaseKey, {
        auth: { autoRefreshToken: false, persistSession: false }
    })
    : null;
const usesCloudStorage = Boolean(supabase);
let localWriteQueue = Promise.resolve();

if (process.env.NODE_ENV === "production" && !usesCloudStorage) {
    throw new Error("Production requires Supabase report storage configuration.");
}

function failOnError(result, action) {
    if (result.error) {
        throw new Error(`${action}: ${result.error.message}`);
    }

    return result.data;
}

function rowToReport(row) {
    return {
        id: row.id,
        name: row.name,
        title: row.title,
        details: row.details || "",
        category: row.category,
        latitude: row.latitude,
        longitude: row.longitude,
        photoName: row.photo_name,
        photoPath: null,
        photoStoragePath: row.photo_path,
        analysis: row.analysis || { detections: [] },
        priority: row.priority,
        status: row.status,
        createdAt: row.created_at,
        resolvedAt: row.resolved_at || undefined
    };
}

function reportToRow(report) {
    return {
        id: report.id,
        name: report.name,
        title: report.title,
        details: report.details || "",
        category: report.category,
        latitude: String(report.latitude),
        longitude: String(report.longitude),
        photo_name: report.photoName,
        photo_path: report.photoStoragePath || null,
        analysis: report.analysis || { detections: [] },
        priority: report.priority,
        status: report.status,
        created_at: report.createdAt,
        resolved_at: report.resolvedAt || null
    };
}

async function readLocalReports() {
    try {
        const contents = await fs.promises.readFile(localReportsFile, "utf8");
        const reports = JSON.parse(contents);
        if (!Array.isArray(reports)) {
            throw new Error("Local report data must be a JSON array.");
        }
        return reports;
    } catch (error) {
        if (error.code === "ENOENT") {
            return [];
        }
        throw error;
    }
}

async function writeLocalReports(reports) {
    await fs.promises.mkdir(path.dirname(localReportsFile), { recursive: true });
    const temporaryFile = `${localReportsFile}.tmp`;
    await fs.promises.writeFile(
        temporaryFile,
        `${JSON.stringify(reports, null, 2)}\n`,
        "utf8"
    );
    await fs.promises.rename(temporaryFile, localReportsFile);
}

function mutateLocalReports(mutator) {
    const operation = localWriteQueue.then(async () => {
        const reports = await readLocalReports();
        const result = await mutator(reports);
        await writeLocalReports(reports);
        return result;
    });
    localWriteQueue = operation.catch(() => {});
    return operation;
}

async function initialize() {
    if (!supabase) {
        await fs.promises.mkdir(path.dirname(localReportsFile), { recursive: true });
        await fs.promises.mkdir(localPhotosDirectory, { recursive: true });
        await readLocalReports();
        return;
    }

    failOnError(
        await supabase.from("community_reports").select("id").limit(1),
        "Supabase report table is unavailable"
    );
    failOnError(
        await supabase.storage.from(bucketName).list("", { limit: 1 }),
        "Supabase photo bucket is unavailable"
    );
}

async function list() {
    if (supabase) {
        const rows = failOnError(
            await supabase
                .from("community_reports")
                .select("*")
                .order("created_at", { ascending: false }),
            "Could not load reports"
        );
        return rows.map(rowToReport);
    }

    await localWriteQueue;
    return readLocalReports();
}

async function save(report) {
    if (supabase) {
        const extension = path.extname(report.photoName || "").toLowerCase();
        const storagePath = `${report.id}${extension}`;
        const image = await fs.promises.readFile(report.photoPath);
        const uploaded = await supabase.storage
            .from(bucketName)
            .upload(storagePath, image, {
                contentType: report.photoMimeType || "application/octet-stream",
                upsert: false
            });
        failOnError(uploaded, "Could not save report photo");
        report.photoStoragePath = storagePath;

        try {
            failOnError(
                await supabase.from("community_reports").insert(reportToRow(report)),
                "Could not save report"
            );
        } catch (error) {
            await supabase.storage.from(bucketName).remove([storagePath]);
            throw error;
        }
        return report;
    }

    const sourcePhoto = report.photoPath;
    const extension = path.extname(report.photoName || "")
        .toLowerCase()
        .replace(/[^.a-z0-9]/g, "");
    const persistentPhoto = path.join(
        localPhotosDirectory,
        `${report.id}${extension}`
    );
    await fs.promises.copyFile(sourcePhoto, persistentPhoto);
    report.photoPath = persistentPhoto;

    try {
        await mutateLocalReports(reports => {
            reports.unshift(report);
        });
    } catch (error) {
        report.photoPath = sourcePhoto;
        await fs.promises.unlink(persistentPhoto).catch(() => {});
        throw error;
    }

    await fs.promises.unlink(sourcePhoto).catch(() => {});
    return report;
}

async function update(id, changes) {
    if (supabase) {
        const databaseChanges = {};
        if (changes.priority !== undefined) {
            databaseChanges.priority = changes.priority;
        }
        if (changes.status !== undefined) {
            databaseChanges.status = changes.status;
        }
        if (changes.resolvedAt !== undefined) {
            databaseChanges.resolved_at = changes.resolvedAt;
        }

        const row = failOnError(
            await supabase
                .from("community_reports")
                .update(databaseChanges)
                .eq("id", id)
                .select("*")
                .maybeSingle(),
            "Could not update report"
        );
        return row ? rowToReport(row) : null;
    }

    return mutateLocalReports(reports => {
        const report = reports.find(item => item.id === id);
        if (!report) {
            return null;
        }
        Object.assign(report, changes);
        return { ...report };
    });
}

async function clear() {
    if (supabase) {
        const reports = await list();
        const ids = reports.map(report => report.id);
        if (!ids.length) {
            return;
        }

        failOnError(
            await supabase.from("community_reports").delete().in("id", ids),
            "Could not clear reports"
        );
        const photoPaths = reports
            .map(report => report.photoStoragePath)
            .filter(Boolean);
        if (photoPaths.length) {
            failOnError(
                await supabase.storage.from(bucketName).remove(photoPaths),
                "Could not remove report photos"
            );
        }
        return;
    }

    await mutateLocalReports(async reports => {
        await Promise.all(reports.map(report =>
            report.photoPath
                ? fs.promises.unlink(report.photoPath).catch(() => {})
                : Promise.resolve()
        ));
        reports.length = 0;
    });
}

module.exports = {
    clear,
    initialize,
    list,
    save,
    update,
    usesCloudStorage
};
