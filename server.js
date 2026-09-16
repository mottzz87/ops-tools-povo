"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const configPath = path.join(__dirname, "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

const HOST = config.host || "127.0.0.1";
const PORT = Number(config.port || 6535);
const DATA_FILE = path.resolve(
  config.dataFile || path.join(__dirname, "data", "povo.json")
);

const MAX = 24;
const MS7 = 7 * 24 * 60 * 60 * 1000;

// ==============================
// 初始化
// ==============================

const dataDir = path.dirname(DATA_FILE);

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

if (!fs.existsSync(DATA_FILE)) {
  saveData({
    history: []
  });
}

// ==============================
// JSON 数据
// ==============================

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const data = JSON.parse(raw);

    if (!data || !Array.isArray(data.history)) {
      return {
        history: []
      };
    }

    return {
      history: data.history
    };
  } catch (err) {
    console.error("[POVO] Failed to load data:", err);

    return {
      history: []
    };
  }
}

function saveData(data) {
  const tmpFile = DATA_FILE + ".tmp";

  fs.writeFileSync(
    tmpFile,
    JSON.stringify(data, null, 2) + "\n",
    "utf8"
  );

  fs.renameSync(tmpFile, DATA_FILE);
}

// ==============================
// HTTP
// ==============================

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);

  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });

  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store"
  });

  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk;

      // 防止异常大的请求
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}

// ==============================
// 数据校验
// ==============================

function normalizeRecord(record, index) {
  if (!record || typeof record !== "object") {
    return null;
  }

  const start = String(record.start || "");
  const end = String(record.end || "");

  if (!start || !end) {
    return null;
  }

  const startTime = new Date(start).getTime();
  const endTime = new Date(end).getTime();

  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    return null;
  }

  if (endTime <= startTime) {
    return null;
  }

  return {
    no: index + 1,
    start,
    end
  };
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .slice(0, MAX)
    .map((record, index) => normalizeRecord(record, index))
    .filter(Boolean)
    .map((record, index) => ({
      ...record,
      no: index + 1
    }));
}

// ==============================
// API
// ==============================

async function handleRequest(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");

  console.log(
    `[POVO] ${req.method} ${url.pathname}`
  );

  // --------------------------------
  // Health
  // --------------------------------

  if (
    (req.method === "GET" || req.method === "HEAD") &&
    url.pathname === "/health"
  ) {
    if (req.method === "HEAD") {
      res.writeHead(200);
      res.end();
      return;
    }

    sendJson(res, 200, {
      ok: true,
      service: "povo-api"
    });

    return;
  }

  // --------------------------------
  // GET /povo/api/data
  // --------------------------------

  if (
    (req.method === "GET" || req.method === "HEAD") &&
    url.pathname === "/povo/api/data"
  ) {
    const data = loadData();

    if (req.method === "HEAD") {
      res.writeHead(200);
      res.end();
      return;
    }

    sendJson(res, 200, {
      ok: true,
      history: data.history,
      max: MAX
    });

    return;
  }

  // --------------------------------
  // POST /povo/api/use
  // --------------------------------

  if (
    req.method === "POST" &&
    url.pathname === "/povo/api/use"
  ) {
    let body;

    try {
      body = await readBody(req);
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        error: err.message
      });
      return;
    }

    const start = String(body.start || "");

    if (!start) {
      sendJson(res, 400, {
        ok: false,
        error: "start is required"
      });
      return;
    }

    const startTime = new Date(start).getTime();

    if (!Number.isFinite(startTime)) {
      sendJson(res, 400, {
        ok: false,
        error: "invalid start"
      });
      return;
    }

    const endTime = startTime + MS7;

    const end = new Date(endTime);

    // 保持 datetime-local 格式
    const pad = n => String(n).padStart(2, "0");

    const endString =
      `${end.getFullYear()}-` +
      `${pad(end.getMonth() + 1)}-` +
      `${pad(end.getDate())}T` +
      `${pad(end.getHours())}:` +
      `${pad(end.getMinutes())}`;

    const data = loadData();

    if (data.history.length >= MAX) {
      sendJson(res, 409, {
        ok: false,
        error: "limit_reached",
        message: `最多只能使用 ${MAX} 次`,
        history: data.history
      });

      return;
    }

    const record = {
      no: data.history.length + 1,
      start,
      end: endString
    };

    data.history.push(record);

    data.history = normalizeHistory(data.history);

    saveData(data);

    sendJson(res, 200, {
      ok: true,
      record,
      history: data.history,
      max: MAX
    });

    return;
  }

  // --------------------------------
  // POST /povo/api/undo
  // --------------------------------

  if (
    req.method === "POST" &&
    url.pathname === "/povo/api/undo"
  ) {
    let body;

    try {
      body = await readBody(req);
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        error: err.message
      });
      return;
    }

    const data = loadData();

    if (data.history.length === 0) {
      sendJson(res, 400, {
        ok: false,
        error: "nothing_to_undo"
      });

      return;
    }

    let index = data.history.length - 1;

    // 如果指定 no，则删除指定记录
    if (body.no !== undefined) {
      const no = Number(body.no);

      if (!Number.isInteger(no)) {
        sendJson(res, 400, {
          ok: false,
          error: "invalid no"
        });

        return;
      }

      index = data.history.findIndex(
        record => Number(record.no) === no
      );

      if (index === -1) {
        sendJson(res, 404, {
          ok: false,
          error: "record_not_found"
        });

        return;
      }
    }

    const removed = data.history.splice(index, 1)[0];

    data.history = normalizeHistory(data.history);

    saveData(data);

    sendJson(res, 200, {
      ok: true,
      removed,
      history: data.history,
      max: MAX
    });

    return;
  }

  // --------------------------------
  // POST /povo/api/reset
  // --------------------------------

  if (
    req.method === "POST" &&
    url.pathname === "/povo/api/reset"
  ) {
    saveData({
      history: []
    });

    sendJson(res, 200, {
      ok: true,
      history: [],
      max: MAX
    });

    return;
  }

  // --------------------------------
  // POST /povo/api/import
  // --------------------------------

  if (
    req.method === "POST" &&
    url.pathname === "/povo/api/import"
  ) {
    let body;

    try {
      body = await readBody(req);
    } catch (err) {
      sendJson(res, 400, {
        ok: false,
        error: err.message
      });
      return;
    }

    if (!Array.isArray(body.history)) {
      sendJson(res, 400, {
        ok: false,
        error: "history must be an array"
      });

      return;
    }

    const imported = normalizeHistory(body.history);

    if (imported.length > MAX) {
      sendJson(res, 400, {
        ok: false,
        error: "too_many_records"
      });

      return;
    }

    const data = loadData();

    // 服务器已经有数据时，不允许 import 覆盖
    if (data.history.length > 0) {
      sendJson(res, 409, {
        ok: false,
        error: "server_has_data",
        history: data.history,
        max: MAX
      });

      return;
    }

    data.history = imported;

    saveData(data);

    sendJson(res, 200, {
      ok: true,
      history: data.history,
      max: MAX
    });

    return;
  }

  // --------------------------------
  // 404
  // --------------------------------

  sendJson(res, 404, {
    ok: false,
    error: "not_found"
  });
}

// ==============================
// Server
// ==============================

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(err => {
    console.error("[POVO] Request error:", err);

    if (!res.headersSent) {
      sendJson(res, 500, {
        ok: false,
        error: "internal_server_error"
      });
    } else {
      res.end();
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(
    `[POVO] API listening on http://${HOST}:${PORT}`
  );

  console.log(
    `[POVO] Data file: ${DATA_FILE}`
  );
});

process.on("SIGTERM", () => {
  console.log("[POVO] SIGTERM received");
  server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  console.log("[POVO] SIGINT received");
  server.close(() => process.exit(0));
});