require("dotenv").config();

const express = require("express");
const multer = require("multer");
const nodemailer = require("nodemailer");
const path = require("path");
const twilio = require("twilio");
const fs = require("fs");
const { spawn } = require("child_process");
const readline = require("readline");
const reportStore = require("./report-store");

const app = express();
const port = Number(process.env.PORT) || 3000;
const upload = multer({
    dest: path.join(__dirname, "uploads"),
    limits: { fileSize: 8 * 1024 * 1024 }
});
const reportCategories = [
    "Blocked sidewalk",
    "Road hazard",
    "Illegal parking",
    "Damaged infrastructure",
    "Debris or obstruction",
    "Other"
];
const reportPriorities = ["high", "medium", "low"];
const yoloRequests = new Map();
let yoloWorker = null;
let nextYoloRequestId = 0;

function rejectYoloRequests(error) {
    for (const [requestId, pending] of yoloRequests) {
        clearTimeout(pending.timeout);
        pending.reject(error);
        yoloRequests.delete(requestId);
    }
}

function startYoloWorker() {
    if (yoloWorker && yoloWorker.exitCode === null && !yoloWorker.killed) {
        return yoloWorker;
    }

    const workspacePython = path.join(
        __dirname,
        ".venv",
        process.platform === "win32" ? "Scripts" : "bin",
        process.platform === "win32" ? "python.exe" : "python"
    );
    const useWorkspacePython = !process.env.PYTHON_EXECUTABLE &&
        fs.existsSync(workspacePython);
    const pythonCommand = process.env.PYTHON_EXECUTABLE ||
        (useWorkspacePython
            ? workspacePython
            : process.platform === "win32"
                ? "py"
                : "python3");
    const pythonArgs = process.env.PYTHON_EXECUTABLE || useWorkspacePython
        ? []
        : process.platform === "win32"
            ? ["-3"]
            : [];
    const worker = spawn(
        pythonCommand,
        [...pythonArgs, "-u", path.join(__dirname, "yolo_worker.py")],
        { cwd: __dirname, windowsHide: true }
    );
    yoloWorker = worker;

    const output = readline.createInterface({ input: worker.stdout });
    output.on("line", line => {
        let message;
        try {
            message = JSON.parse(line);
        } catch (error) {
            console.error("YOLO worker returned an invalid response.");
            return;
        }

        if (message.type === "startup_error") {
            rejectYoloRequests(new Error(message.error));
            return;
        }

        const pending = yoloRequests.get(message.id);
        if (!pending) {
            return;
        }

        clearTimeout(pending.timeout);
        yoloRequests.delete(message.id);
        if (message.error) {
            const error = new Error(message.error);
            error.statusCode = 422;
            pending.reject(error);
        } else {
            pending.resolve(message.result);
        }
    });

    worker.stderr.on("data", data => {
        process.stderr.write(`[YOLO] ${data}`);
    });
    worker.on("error", error => {
        if (yoloWorker === worker) {
            yoloWorker = null;
        }
        rejectYoloRequests(error);
    });
    worker.on("exit", (code, signal) => {
        if (yoloWorker === worker) {
            yoloWorker = null;
        }
        if (yoloRequests.size) {
            rejectYoloRequests(
                new Error(`YOLO worker stopped (${signal || code}).`)
            );
        }
    });
    worker.stdin.on("error", error => rejectYoloRequests(error));

    return worker;
}

function analyzeReportImage(imagePath) {
    const worker = startYoloWorker();
    const requestId = String(++nextYoloRequestId);

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            yoloRequests.delete(requestId);
            reject(new Error("Photo analysis timed out."));
        }, 180000);

        yoloRequests.set(requestId, { resolve, reject, timeout });
        try {
            worker.stdin.write(
                JSON.stringify({ id: requestId, imagePath }) + "\n",
                error => {
                    if (!error) {
                        return;
                    }

                    const pending = yoloRequests.get(requestId);
                    if (pending) {
                        clearTimeout(pending.timeout);
                        yoloRequests.delete(requestId);
                        pending.reject(error);
                    }
                }
            );
        } catch (error) {
            clearTimeout(timeout);
            yoloRequests.delete(requestId);
            reject(error);
        }
    });
}

process.on("exit", () => {
    if (yoloWorker) {
        yoloWorker.kill();
    }
});

app.use((request, response, next) => {
    response.header("Access-Control-Allow-Origin", "*");
    response.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    response.header("Access-Control-Allow-Headers", "Content-Type");

    if (request.method === "OPTIONS") {
        return response.sendStatus(204);
    }

    next();
});

app.use(express.json());
app.use(express.static(__dirname));

app.get("/submit", (request, response) => {
    response.sendFile(path.join(__dirname, "System.html"));
});

app.get("/dashboard", (request, response) => {
    response.sendFile(path.join(__dirname, "dashboard.html"));
});

app.get("/admin", (request, response) => {
    response.sendFile(path.join(__dirname, "admin.html"));
});

app.post("/api/assist", async (request, response) => {
    const title = typeof request.body.title === "string"
        ? request.body.title.trim().slice(0, 120)
        : "";
    const details = typeof request.body.details === "string"
        ? request.body.details.trim().slice(0, 400)
        : "";
    const note = [title, details].filter(Boolean).join("\n");

    if (!note) {
        return response.status(400).json({
            error: "Add a short description before asking AI to help."
        });
    }

    const ollamaUrl = (process.env.OLLAMA_URL || "http://127.0.0.1:11434")
        .replace(/\/+$/, "");
    const model = process.env.OLLAMA_MODEL || "qwen2.5vl:3b";

    try {
        const aiResponse = await fetch(`${ollamaUrl}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(120000),
            body: JSON.stringify({
                model,
                stream: false,
                format: "json",
                messages: [
                    {
                        role: "system",
                        content: `Polish the user's note into a short report title and choose a category supported by the note. Do not add or infer facts, locations, conditions, causes, or urgency. If the note does not clearly support a category, use Other. Return a JSON object with title (at most 120 characters) and category. The category must be exactly one of: ${reportCategories.join(", ")}.`
                    },
                    {
                        role: "user",
                        content: note
                    }
                ],
                options: { temperature: 0 }
            })
        });

        if (!aiResponse.ok) {
            return response.status(503).json({
                error: `Ollama could not run ${model}. Start Ollama and make sure this model is installed.`
            });
        }

        const result = await aiResponse.json();
        let draft;

        try {
            draft = JSON.parse(result.message && result.message.content);
        } catch (error) {
            return response.status(502).json({
                error: "Local AI returned an unreadable draft. Please try again."
            });
        }

        return response.json({
            title: typeof draft.title === "string" && draft.title.trim()
                ? draft.title.trim().slice(0, 120)
                : title,
            details,
            category: reportCategories.includes(draft.category)
                ? draft.category
                : "Other"
        });
    } catch (error) {
        console.error("Local AI request failed:", error.message);
        return response.status(503).json({
            error: "Local AI is unavailable. Start Ollama and install the configured model."
        });
    }
});

function smsIsConfigured() {
    return Boolean(
        process.env.TWILIO_ACCOUNT_SID &&
        process.env.TWILIO_AUTH_TOKEN &&
        process.env.TWILIO_PHONE_NUMBER &&
        process.env.SMS_TO
    );
}

function summarizePhotoAnalysis(analysis, report) {
    const detections = Array.isArray(analysis.detections)
        ? analysis.detections
        : [];
    const vehicleLabels = new Set([
        "car",
        "motorcycle",
        "bus",
        "truck",
        "bicycle"
    ]);
    const labels = [...new Set(detections.map(detection =>
        detection.label.toLowerCase()
    ))];
    const sidewalkHazards = labels.filter(label =>
        label.includes("sidewalk") || [
            "fallen tree",
            "fallen tree branch",
            "construction barrier",
            "traffic cone",
            "garbage pile",
            "road debris",
            "construction debris"
        ].includes(label)
    );
    const roadHazards = labels.filter(label => [
        "pothole",
        "cracked pavement",
        "broken pavement",
        "open manhole",
        "flooded road",
        "exposed wire",
        "damaged guardrail",
        "sinkhole",
        "fallen sign"
    ].includes(label));

    if (sidewalkHazards.length) {
        return `Possible sidewalk obstruction detected: ${sidewalkHazards.join(", ")}.`;
    }

    if (roadHazards.length) {
        return `Possible road hazard detected: ${roadHazards.join(", ")}.`;
    }

    const otherHazards = labels.filter(label =>
        label !== "person" && !vehicleLabels.has(label)
    );
    if (otherHazards.length) {
        return `Possible public-space hazard detected: ${otherHazards.join(", ")}.`;
    }

    const hasVehicle = labels.some(label => vehicleLabels.has(label));
    if (hasVehicle && report.category === "Illegal parking") {
        return "A vehicle was detected, but AI cannot determine whether it blocks access or violates parking rules.";
    }

    const reportedCategory = report.category === "Other" && report.details
        ? report.details
        : report.category.toLowerCase();
    const reportedIssue = typeof report.title === "string" && report.title.trim()
        ? `: ${report.title.trim().slice(0, 120)}`
        : "";
    const vehicleNote = hasVehicle
        ? " A vehicle is also visible, but its presence alone does not confirm the reported obstruction."
        : "";

    return `Reported ${reportedCategory}${reportedIssue}. No configured obstruction was detected; this does not confirm the area is clear.${vehicleNote}`;
}

async function notifyPersonnel(report) {
    const notifications = {
        sms: { sent: false, reason: "SMS is not configured" },
        email: { sent: false, reason: "Email is not configured" }
    };

    if (smsIsConfigured()) {
        try {
            const client = twilio(
                process.env.TWILIO_ACCOUNT_SID,
                process.env.TWILIO_AUTH_TOKEN
            );

            const message = await client.messages.create({
                body: `New Kita - Kita ${report.category} report: ${report.title}. Location: ${report.latitude}, ${report.longitude}.`,
                from: process.env.TWILIO_PHONE_NUMBER,
                to: process.env.SMS_TO
            });

            notifications.sms = { sent: true, messageSid: message.sid };
        } catch (error) {
            console.error("SMS notification failed:", error.message);
            notifications.sms = { sent: false, reason: "SMS delivery failed" };
        }
    }

    if (emailIsConfigured()) {
        try {
            const mapUrl =
                `https://www.google.com/maps?q=${report.latitude},${report.longitude}`;

            const transporter = nodemailer.createTransport({
                host: process.env.SMTP_HOST || "smtp.gmail.com",
                port: Number(process.env.SMTP_PORT) || 465,
                secure: process.env.SMTP_SECURE !== "false",
                auth: {
                    user: process.env.SMTP_USER,
                    pass: process.env.SMTP_PASS
                }
            });

            await transporter.sendMail({
                from: process.env.EMAIL_FROM || process.env.SMTP_USER,
                to: process.env.EMAIL_TO,
                subject: `[Kita - Kita] Pending report ${report.id}: ${report.title}`,
                text: [
                    "KITA - KITA COMMUNITY REPORT",
                    "===========================",
                    "",
                    "Status: PENDING",
                    `Report ID: ${report.id}`,
                    `Submitted by: ${report.name}`,
                    `Issue: ${report.title}`,
                    `Category and description: ${report.category === "Other" && report.details
                        ? `Others: ${report.details}`
                        : report.category}${report.details && report.category !== "Other"
                        ? ` - ${report.details}`
                        : ""}`,
                    `Submitted: ${new Date(report.createdAt).toLocaleString()}`,
                    "",
                    "LOCATION",
                    `Coordinates: ${report.latitude}, ${report.longitude}`,
                    `Open map: ${mapUrl}`,
                    "",
                    "AI PHOTO ANALYSIS",
                    ...(report.analysis.detections.length
                        ? report.analysis.detections.map(detection =>
                            `- ${detection.label}: ${Math.round(detection.confidence * 100)}% confidence`
                        )
                        : ["No configured objects were detected."]),
                    `AI conclusion: ${summarizePhotoAnalysis(report.analysis, report)}`,
                    "AI suggestions do not determine whether a report is valid.",
                    "",
                    "ATTACHMENT",
                    `Photo: ${report.photoName || "No photo provided"}`,
                    "",
                    "Please review this report and mark it resolved when the issue has been handled."
                ].join("\n"),
                attachments: report.photoPath
                    ? [{
                        filename: report.photoName || "civicsight-report-image",
                        path: report.photoPath
                    }]
                    : []
            });

            notifications.email = { sent: true };
        } catch (error) {
            console.error("Email notification failed:", error.message);
            notifications.email = { sent: false, reason: "Email delivery failed" };
        }
    }

    return {
        sent: notifications.sms.sent || notifications.email.sent,
        ...notifications
    };
}

function emailIsConfigured() {
    return Boolean(
        process.env.SMTP_USER &&
        process.env.SMTP_PASS &&
        process.env.EMAIL_TO
    );
}

function publicReport(report) {
    const safeReport = { ...report };
    delete safeReport.photoPath;
    delete safeReport.photoStoragePath;
    delete safeReport.photoMimeType;
    delete safeReport.analysis;
    return safeReport;
}

function requireAdmin(request, response, next) {
    const configuredSecret = process.env.ADMIN_SECRET;

    if (!configuredSecret) {
        return response.status(403).json({
            error: "Admin actions are disabled. Set ADMIN_SECRET in the server environment."
        });
    }

    if (request.headers["x-admin-key"] !== configuredSecret) {
        return response.status(401).json({
            error: "Admin access required."
        });
    }

    next();
}

app.get("/api/admin/verify", requireAdmin, (request, response) => {
    response.json({ authorized: true });
});

app.get("/api/reports", async (request, response, next) => {
    try {
        const reports = await reportStore.list();
        response.json(reports.map(publicReport));
    } catch (error) {
        next(error);
    }
});

app.delete("/api/reports", requireAdmin, async (request, response, next) => {
    try {
        await reportStore.clear();
        return response.json({ cleared: true });
    } catch (error) {
        next(error);
    }
});

app.patch("/api/reports/:id/priority", requireAdmin, async (request, response, next) => {
    const { priority } = request.body;
    if (!reportPriorities.includes(priority)) {
        return response.status(400).json({
            error: "Priority must be high, medium, or low."
        });
    }

    try {
        const report = await reportStore.update(request.params.id, { priority });
        if (!report) {
            return response.status(404).json({ error: "Report not found." });
        }

        return response.json({ report: publicReport(report) });
    } catch (error) {
        next(error);
    }
});

app.post("/api/reports", upload.single("photo"), async (request, response) => {
    const { latitude, longitude, title } = request.body;
    const name = typeof request.body.name === "string"
        ? request.body.name.trim().slice(0, 100)
        : "";
    const category = request.body.category;
    const details = typeof request.body.details === "string"
        ? request.body.details.trim().slice(0, 400)
        : "";

    if (!request.file || !name || !title || !latitude || !longitude ||
        !reportCategories.includes(category) || (category === "Other" && !details)) {
        return response.status(400).json({
            error: "A name, photo, title, valid category, and location are required. Other categories need a description."
        });
    }

    let analysis;
    try {
        analysis = await analyzeReportImage(request.file.path);
    } catch (error) {
        console.error("Required report photo analysis failed:", error.message);
        if (process.env.AI_ANALYSIS_OPTIONAL !== "true") {
            await fs.promises.unlink(request.file.path).catch(() => {});
            return response.status(error.statusCode || 503).json({
                error: "AI photo analysis is required, but could not analyze this image. Please try again with another photo."
            });
        }

        analysis = {
            detections: [],
            personDetected: false,
            vehicleDetected: false,
            hazardDetected: false
        };
    }

    const report = {
        id: `CS-${Date.now()}`,
        name,
        title,
        details,
        category,
        latitude,
        longitude,
        photoName: request.file ? request.file.originalname : null,
        photoPath: request.file ? request.file.path : null,
        photoMimeType: request.file ? request.file.mimetype : null,
        analysis,
        priority: "medium",
        status: "Pending",
        createdAt: new Date().toISOString()
    };

    try {
        await reportStore.save(report);
    } catch (error) {
        console.error("Report could not be saved:", error.message);
        await fs.promises.unlink(request.file.path).catch(() => {});
        return response.status(503).json({
            error: "The report could not be saved. Please try again later."
        });
    }

    const notification = await notifyPersonnel(report);
    if (reportStore.usesCloudStorage && report.photoPath) {
        await fs.promises.unlink(report.photoPath).catch(() => {});
    }
    return response.status(201).json({
        report: publicReport(report),
        notification
    });
});

app.patch("/api/reports/:id/resolve", requireAdmin, async (request, response, next) => {
    try {
        const report = await reportStore.update(request.params.id, {
            status: "Resolved",
            resolvedAt: new Date().toISOString()
        });
        if (!report) {
            return response.status(404).json({ error: "Report not found." });
        }

        return response.json({ report: publicReport(report) });
    } catch (error) {
        next(error);
    }
});

app.use((error, request, response, next) => {
    console.error("Request failed:", error.message);

    if (response.headersSent) {
        return next(error);
    }

    const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 500;
    const message =
        status === 413
            ? "The uploaded image is too large. Maximum size is 8 MB."
            : "The server could not process the report.";

    response.status(status).json({ error: message });
});

reportStore.initialize()
    .then(() => {
        app.listen(port, () => {
            console.log(`Kita - Kita backend running at http://localhost:${port}`);
        });
    })
    .catch(error => {
        console.error("Report storage initialization failed:", error.message);
        process.exitCode = 1;
    });
