"use strict";

require("dotenv").config();

const crypto = require("node:crypto");
const path = require("node:path");
const express = require("express");
const cors = require("cors");
const {Pool} = require("pg");
const twilio = require("twilio");

const PORT = Number(process.env.PORT || 3000);
const SLOT_MINUTES = 10;
const FOCUS_PERIOD_MAX_DAYS = 14;

const STATUS = {
  OPEN: "open",
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  CANCELLED: "cancelled",
  CONFIRMED: "confirmed",
  NO_ANSWER: "no_answer",
};

const ALT_STATUS = {
  REQUESTED: "requested",
  HANDLED: "handled",
  CANCELLED: "cancelled",
};

const DEFAULT_ADMIN_CODE = process.env.SYSTEM_ADMIN_CODE || "1234";
const DEFAULT_PUBLIC_CONFIG = {
  semesterLabel: "2026학년도 1학기",
  semesterStartDate: "2026-03-02",
  midtermDate: "2026-04-20",
  finalDate: "2026-06-15",
  firstRoundFocusStartDate: "2026-03-02",
  firstRoundFocusEndDate: "2026-04-19",
  secondRoundFocusStartDate: "2026-04-20",
  secondRoundFocusEndDate: "2026-06-14",
  professors: [
    {
      id: "prof-1",
      name: "지도교수",
      phone: "010-0000-0000",
      departmentName: "원격수업 학생상담",
      active: true,
    },
  ],
  supportMessage: "예약 확정 시 지도교수와 학생에게 문자 안내를 보냅니다.",
};

class AppError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : (
    process.env.NODE_ENV === "development" ? false : {rejectUnauthorized: false}
  ),
});

function getKstDate(date, time) {
  return new Date(`${date}T${time}:00+09:00`);
}

function getDayDiffInclusive(startDate, endDate) {
  const start = Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate());
  const end = Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate());
  return Math.floor((end - start) / (24 * 60 * 60 * 1000)) + 1;
}

function formatDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function formatTime(date) {
  return date.toISOString().slice(11, 16);
}

function normalizePhone(phone) {
  return String(phone || "").replace(/[^\d]/g, "");
}

function maskPhoneLast4(phone) {
  return normalizePhone(phone).slice(-4);
}

function ensureString(value, field) {
  if (!value || typeof value !== "string") {
    throw new AppError(400, "invalid-argument", `${field} 값이 필요합니다.`);
  }
  return value.trim();
}

function reservationStatusLabel(status) {
  if (status === STATUS.PENDING) {
    return "승인대기";
  }
  if (status === STATUS.APPROVED) {
    return "면담확정";
  }
  if (status === STATUS.NO_ANSWER) {
    return "통화불가/미신청";
  }
  return "반려/취소";
}

function alternateRequestStatusLabel(status) {
  if (status === ALT_STATUS.REQUESTED) {
    return "대체면담 조율요청";
  }
  if (status === ALT_STATUS.HANDLED) {
    return "대체면담 조율완료";
  }
  return "대체면담 취소";
}

function openCounselStatusLabel(status) {
  if (status === ALT_STATUS.REQUESTED) {
    return "수시면담 요청접수";
  }
  if (status === ALT_STATUS.HANDLED) {
    return "수시면담 조율완료";
  }
  return "수시면담 취소";
}

function getProfessorList(config) {
  return Array.isArray(config.professors) ? config.professors.filter((item) => item && item.id) : [];
}

function getProfessorById(config, professorId) {
  return getProfessorList(config).find((professor) => professor.id === professorId && professor.active !== false) || null;
}

function getPhaseForDate(date, config) {
  const semesterStart = getKstDate(config.semesterStartDate, "00:00");
  const midtermStart = getKstDate(config.midtermDate, "00:00");
  const finalStart = getKstDate(config.finalDate, "00:00");

  if (date < semesterStart || date >= finalStart) {
    throw new AppError(400, "failed-precondition", "학기 상담 가능 기간 밖의 일정입니다.");
  }
  return date < midtermStart ? 1 : 2;
}

function getFocusRangeForPhase(phase, config) {
  if (phase === 1) {
    return {
      start: getKstDate(config.firstRoundFocusStartDate, "00:00"),
      endExclusive: getKstDate(config.firstRoundFocusEndDate, "23:59"),
    };
  }
  return {
    start: getKstDate(config.secondRoundFocusStartDate, "00:00"),
    endExclusive: getKstDate(config.secondRoundFocusEndDate, "23:59"),
  };
}

function ensureDateWithinFocusPeriod(date, phase, config) {
  const focusRange = getFocusRangeForPhase(phase, config);
  if (date < focusRange.start || date > focusRange.endExclusive) {
    throw new AppError(400, "failed-precondition", `${phase}차 상담 시간은 집중면담기간 안에서만 등록할 수 있습니다.`);
  }
}

function sanitizeProfessorDirectory(entries, existingCodes = {}) {
  if (!Array.isArray(entries) || !entries.length) {
    throw new AppError(400, "invalid-argument", "교수 목록이 비어 있습니다.");
  }

  const ids = new Set();
  const publicProfessors = [];
  const professorAdminCodes = {};

  entries.forEach((entry, index) => {
    const id = ensureString(entry.id, `entries[${index}].id`);
    const name = ensureString(entry.name, `entries[${index}].name`);
    const phone = ensureString(entry.phone, `entries[${index}].phone`);
    const departmentName = ensureString(entry.departmentName, `entries[${index}].departmentName`);
    const submittedCode = String(entry.adminCode || "").trim();
    const adminCode = submittedCode || existingCodes[id];
    const active = entry.active !== false;

    if (ids.has(id)) {
      throw new AppError(409, "already-exists", `중복 교수 ID가 있습니다: ${id}`);
    }
    if (!adminCode) {
      throw new AppError(400, "invalid-argument", `${id} 교수의 로그인 코드가 비어 있습니다.`);
    }
    ids.add(id);

    publicProfessors.push({id, name, phone, departmentName, active});
    professorAdminCodes[id] = adminCode;
  });

  return {publicProfessors, professorAdminCodes};
}

function sanitizeRosterEntries(entries, config) {
  if (!Array.isArray(entries)) {
    throw new AppError(400, "invalid-argument", "학생 명단 형식이 올바르지 않습니다.");
  }

  const professorIds = getProfessorList(config).map((professor) => professor.id);
  const hasMultipleProfessors = professorIds.length > 1;
  const seen = new Set();

  return entries.map((entry, index) => {
    const studentNo = ensureString(entry.studentNo, `entries[${index}].studentNo`);
    const studentName = ensureString(entry.studentName, `entries[${index}].studentName`);
    const phone = String(entry.phone || "").trim();
    let professorId = String(entry.professorId || "").trim();

    if (!professorId && professorIds.length === 1) {
      professorId = professorIds[0];
    }
    if (hasMultipleProfessors && !professorId) {
      throw new AppError(400, "invalid-argument", `${studentNo} 학생의 지도교수 ID가 비어 있습니다.`);
    }
    if (professorId && !professorIds.includes(professorId)) {
      throw new AppError(400, "invalid-argument", `${studentNo} 학생의 지도교수 ID가 교수 목록에 없습니다: ${professorId}`);
    }
    if (seen.has(studentNo)) {
      throw new AppError(409, "already-exists", `중복 학번이 있습니다: ${studentNo}`);
    }
    seen.add(studentNo);

    return {studentNo, studentName, phone, professorId};
  });
}

function filterStudentRosterForProfessor(studentRoster, professorId, config) {
  const activeProfessors = getProfessorList(config).filter((item) => item.active !== false);
  if (activeProfessors.length <= 1) {
    return studentRoster;
  }
  return studentRoster.filter((student) => student.professorId === professorId);
}

function serializeReservation(row) {
  return {
    id: row.id,
    slotId: row.slot_id,
    professorId: row.professor_id || "",
    phase: row.phase,
    status: row.status,
    studentName: row.student_name,
    studentNo: row.student_no,
    phone: row.phone,
    phoneLast4: row.phone_last4,
    note: row.note || "",
    professorName: row.professor_name,
    professorPhone: row.professor_phone,
    departmentName: row.department_name || "",
    semesterLabel: row.semester_label,
    startAt: new Date(row.start_at).toISOString(),
    endAt: new Date(row.end_at).toISOString(),
    statusLabel: reservationStatusLabel(row.status),
  };
}

function serializeAlternateRequest(row) {
  return {
    id: row.id,
    professorId: row.professor_id || "",
    phase: row.phase,
    status: row.status,
    studentName: row.student_name,
    studentNo: row.student_no,
    phone: row.phone,
    phoneLast4: row.phone_last4,
    preferredTimeText: row.preferred_time_text || "",
    reason: row.reason || "",
    professorPhone: row.professor_phone,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    statusLabel: alternateRequestStatusLabel(row.status),
  };
}

function serializeOpenCounselRequest(row) {
  return {
    id: row.id,
    professorId: row.professor_id || "",
    status: row.status,
    studentName: row.student_name,
    studentNo: row.student_no,
    phone: row.phone,
    phoneLast4: row.phone_last4,
    preferredTimeText: row.preferred_time_text || "",
    topic: row.topic || "",
    reason: row.reason || "",
    professorPhone: row.professor_phone,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    statusLabel: openCounselStatusLabel(row.status),
  };
}

function serializeSlot(row) {
  return {
    id: row.id,
    professorId: row.professor_id || "",
    professorName: row.professor_name || "",
    professorPhone: row.professor_phone || "",
    departmentName: row.department_name || "",
    dateKey: row.date_key,
    phase: row.phase,
    status: row.status,
    reservationId: row.reservation_id || null,
    startAt: new Date(row.start_at).toISOString(),
    endAt: new Date(row.end_at).toISOString(),
  };
}

async function initializeSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS student_roster (
      student_no TEXT PRIMARY KEY,
      student_name TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      professor_id TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS availability_slots (
      id TEXT PRIMARY KEY,
      professor_id TEXT NOT NULL,
      professor_name TEXT NOT NULL,
      professor_phone TEXT NOT NULL,
      department_name TEXT NOT NULL DEFAULT '',
      date_key TEXT NOT NULL,
      phase INTEGER NOT NULL,
      status TEXT NOT NULL,
      reservation_id TEXT,
      start_at TIMESTAMPTZ NOT NULL,
      end_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY,
      slot_id TEXT NOT NULL,
      phase INTEGER NOT NULL,
      status TEXT NOT NULL,
      student_name TEXT NOT NULL,
      student_no TEXT NOT NULL,
      phone TEXT NOT NULL,
      phone_last4 TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      professor_id TEXT NOT NULL,
      professor_phone TEXT NOT NULL,
      professor_name TEXT NOT NULL,
      department_name TEXT NOT NULL DEFAULT '',
      semester_label TEXT NOT NULL,
      review_note TEXT NOT NULL DEFAULT '',
      start_at TIMESTAMPTZ NOT NULL,
      end_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS alternate_requests (
      id TEXT PRIMARY KEY,
      student_name TEXT NOT NULL,
      student_no TEXT NOT NULL,
      phone TEXT NOT NULL,
      phone_last4 TEXT NOT NULL,
      professor_id TEXT NOT NULL,
      phase INTEGER NOT NULL,
      preferred_time_text TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      professor_phone TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS open_counsel_requests (
      id TEXT PRIMARY KEY,
      student_name TEXT NOT NULL,
      student_no TEXT NOT NULL,
      phone TEXT NOT NULL,
      phone_last4 TEXT NOT NULL,
      professor_id TEXT NOT NULL,
      preferred_time_text TEXT NOT NULL,
      topic TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      professor_phone TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_slots_professor_start ON availability_slots (professor_id, start_at);
    CREATE INDEX IF NOT EXISTS idx_reservations_professor_start ON reservations (professor_id, start_at);
    CREATE INDEX IF NOT EXISTS idx_reservations_student_phase ON reservations (student_no, professor_id, phase, status);
    CREATE INDEX IF NOT EXISTS idx_alternate_professor_created ON alternate_requests (professor_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_alternate_student_phase ON alternate_requests (student_no, professor_id, phase, status);
    CREATE INDEX IF NOT EXISTS idx_open_counsel_professor_created ON open_counsel_requests (professor_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_open_counsel_student_status ON open_counsel_requests (student_no, professor_id, status);
  `);

  const publicConfig = await getConfigValue("publicConfig");
  if (!publicConfig) {
    await setConfigValue("publicConfig", DEFAULT_PUBLIC_CONFIG);
  }
  const privateConfig = await getConfigValue("privateConfig");
  if (!privateConfig) {
    await setConfigValue("privateConfig", {
      systemAdminCode: DEFAULT_ADMIN_CODE,
      professorAdminCodes: {
        "prof-1": DEFAULT_ADMIN_CODE,
      },
    });
  }
}

async function getConfigValue(key, client = pool) {
  const {rows} = await client.query("SELECT value FROM app_config WHERE key = $1", [key]);
  return rows[0] ? rows[0].value : null;
}

async function setConfigValue(key, value, client = pool) {
  await client.query(`
    INSERT INTO app_config (key, value, updated_at)
    VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT (key)
    DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `, [key, JSON.stringify(value)]);
}

async function getPublicConfig(client = pool) {
  const data = await getConfigValue("publicConfig", client);
  if (!data) {
    return {...DEFAULT_PUBLIC_CONFIG};
  }
  if (!Array.isArray(data.professors) || !data.professors.length) {
    data.professors = DEFAULT_PUBLIC_CONFIG.professors;
  }
  return data;
}

async function getPrivateConfig(client = pool) {
  const data = await getConfigValue("privateConfig", client);
  if (data) {
    return {
      ...data,
      systemAdminCode: data.systemAdminCode || DEFAULT_ADMIN_CODE,
      professorAdminCodes: data.professorAdminCodes || {"prof-1": DEFAULT_ADMIN_CODE},
    };
  }
  return {
    systemAdminCode: DEFAULT_ADMIN_CODE,
    professorAdminCodes: {"prof-1": DEFAULT_ADMIN_CODE},
  };
}

async function getStudentRoster(client = pool) {
  const {rows} = await client.query(`
    SELECT student_no, student_name, phone, professor_id
    FROM student_roster
    ORDER BY student_no ASC
  `);
  return rows.map((row) => ({
    studentNo: row.student_no,
    studentName: row.student_name,
    phone: row.phone,
    professorId: row.professor_id,
  }));
}

async function requireSystemAdminCode(code, client = pool) {
  const submitted = ensureString(code, "adminCode");
  const privateConfig = await getPrivateConfig(client);
  if (submitted !== privateConfig.systemAdminCode) {
    throw new AppError(403, "permission-denied", "시스템 관리자 인증에 실패했습니다.");
  }
}

async function requireProfessorCode(professorId, code, client = pool) {
  const submitted = ensureString(code, "adminCode");
  const privateConfig = await getPrivateConfig(client);
  const savedCode = (privateConfig.professorAdminCodes || {})[professorId];
  if (!savedCode || submitted !== savedCode) {
    throw new AppError(403, "permission-denied", "지도교수 인증에 실패했습니다.");
  }
}

async function assertProfessorAssignment(studentNo, professorId, client = pool) {
  const {rows} = await client.query(`
    SELECT professor_id
    FROM student_roster
    WHERE student_no = $1
  `, [studentNo]);
  if (rows[0] && rows[0].professor_id && rows[0].professor_id !== professorId) {
    throw new AppError(400, "failed-precondition", "해당 학생은 다른 지도교수에게 배정되어 있습니다. 배정된 지도교수로 신청해 주세요.");
  }
}

async function sendSmsMessages(messages) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const sender = process.env.TWILIO_PHONE_NUMBER;
  if (!sid || !token || !sender) {
    return {sent: false, reason: "twilio_not_configured"};
  }

  const client = twilio(sid, token);
  const results = [];
  for (const message of messages) {
    const sent = await client.messages.create({
      to: message.to,
      from: sender,
      body: message.body,
    });
    results.push({sid: sent.sid, to: message.to});
  }
  return {sent: true, results};
}

async function bootstrapConfig(data) {
  await requireSystemAdminCode(data && data.adminCode);
  await initializeSchema();
  return {ok: true};
}

async function updatePublicConfig(data) {
  await requireSystemAdminCode(data && data.adminCode);
  const currentConfig = await getPublicConfig();
  const nextConfig = {
    ...currentConfig,
    semesterLabel: ensureString(data.semesterLabel, "semesterLabel"),
    semesterStartDate: ensureString(data.semesterStartDate, "semesterStartDate"),
    midtermDate: ensureString(data.midtermDate, "midtermDate"),
    finalDate: ensureString(data.finalDate, "finalDate"),
    firstRoundFocusStartDate: ensureString(data.firstRoundFocusStartDate, "firstRoundFocusStartDate"),
    firstRoundFocusEndDate: ensureString(data.firstRoundFocusEndDate, "firstRoundFocusEndDate"),
    secondRoundFocusStartDate: ensureString(data.secondRoundFocusStartDate, "secondRoundFocusStartDate"),
    secondRoundFocusEndDate: ensureString(data.secondRoundFocusEndDate, "secondRoundFocusEndDate"),
    supportMessage: ensureString(data.supportMessage, "supportMessage"),
  };

  const start = getKstDate(nextConfig.semesterStartDate, "00:00");
  const midterm = getKstDate(nextConfig.midtermDate, "00:00");
  const finalDate = getKstDate(nextConfig.finalDate, "00:00");
  const firstFocusStart = getKstDate(nextConfig.firstRoundFocusStartDate, "00:00");
  const firstFocusEnd = getKstDate(nextConfig.firstRoundFocusEndDate, "00:00");
  const secondFocusStart = getKstDate(nextConfig.secondRoundFocusStartDate, "00:00");
  const secondFocusEnd = getKstDate(nextConfig.secondRoundFocusEndDate, "00:00");
  const firstFocusDays = getDayDiffInclusive(firstFocusStart, firstFocusEnd);
  const secondFocusDays = getDayDiffInclusive(secondFocusStart, secondFocusEnd);

  if (!(start < midterm && midterm < finalDate)) {
    throw new AppError(400, "invalid-argument", "학기 시작일, 중간고사일, 기말고사일 순서를 확인해 주세요.");
  }
  if (!(start <= firstFocusStart && firstFocusStart <= firstFocusEnd && firstFocusEnd < midterm)) {
    throw new AppError(400, "invalid-argument", "1차 집중면담기간은 개강일부터 중간고사 전까지 설정해 주세요.");
  }
  if (!(midterm <= secondFocusStart && secondFocusStart <= secondFocusEnd && secondFocusEnd < finalDate)) {
    throw new AppError(400, "invalid-argument", "2차 집중면담기간은 중간고사일부터 기말고사 전까지 설정해 주세요.");
  }
  if (firstFocusDays > FOCUS_PERIOD_MAX_DAYS) {
    throw new AppError(400, "invalid-argument", `1차 집중면담기간은 ${FOCUS_PERIOD_MAX_DAYS}일 이내로 설정해 주세요.`);
  }
  if (secondFocusDays > FOCUS_PERIOD_MAX_DAYS) {
    throw new AppError(400, "invalid-argument", `2차 집중면담기간은 ${FOCUS_PERIOD_MAX_DAYS}일 이내로 설정해 주세요.`);
  }

  await setConfigValue("publicConfig", nextConfig);
  return {ok: true};
}

async function updateStudentRoster(data) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await requireSystemAdminCode(data && data.adminCode, client);
    const config = await getPublicConfig(client);
    const entries = sanitizeRosterEntries(data && data.entries, config);
    await client.query("DELETE FROM student_roster");
    for (const entry of entries) {
      await client.query(`
        INSERT INTO student_roster (student_no, student_name, phone, professor_id)
        VALUES ($1, $2, $3, $4)
      `, [entry.studentNo, entry.studentName, entry.phone, entry.professorId]);
    }
    await client.query("COMMIT");
    return {ok: true, count: entries.length};
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function updateProfessorDirectory(data) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await requireSystemAdminCode(data && data.adminCode, client);
    const publicConfig = await getPublicConfig(client);
    const privateConfig = await getPrivateConfig(client);
    const sanitized = sanitizeProfessorDirectory(data && data.entries, privateConfig.professorAdminCodes || {});
    await setConfigValue("publicConfig", {...publicConfig, professors: sanitized.publicProfessors}, client);
    await setConfigValue("privateConfig", {
      ...privateConfig,
      professorAdminCodes: sanitized.professorAdminCodes,
    }, client);
    await client.query("COMMIT");
    return {ok: true, count: sanitized.publicProfessors.length};
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function updateAdminCode(data) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await requireSystemAdminCode(data && data.adminCode, client);
    const nextAdminCode = ensureString(data.nextAdminCode, "nextAdminCode");
    const privateConfig = await getPrivateConfig(client);
    await setConfigValue("privateConfig", {
      ...privateConfig,
      systemAdminCode: nextAdminCode,
    }, client);
    await client.query("COMMIT");
    return {ok: true};
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function upsertAvailability(data) {
  const professorId = ensureString(data.professorId, "professorId");
  await requireProfessorCode(professorId, data && data.adminCode);
  const entries = Array.isArray(data.entries) ? data.entries : [];
  if (!entries.length) {
    throw new AppError(400, "invalid-argument", "추가할 가능 시간이 없습니다.");
  }

  const config = await getPublicConfig();
  const professor = getProfessorById(config, professorId);
  if (!professor) {
    throw new AppError(404, "not-found", "지도교수 정보를 찾을 수 없습니다.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let slotCount = 0;

    for (const entry of entries) {
      const date = ensureString(entry.date, "date");
      const startTime = ensureString(entry.startTime, "startTime");
      const endTime = ensureString(entry.endTime, "endTime");
      let cursor = getKstDate(date, startTime);
      const end = getKstDate(date, endTime);

      if (!(cursor < end)) {
        throw new AppError(400, "invalid-argument", "상담 종료 시간은 시작 시간보다 늦어야 합니다.");
      }

      while (cursor < end) {
        const next = new Date(cursor.getTime() + SLOT_MINUTES * 60 * 1000);
        if (next > end) {
          break;
        }

        const phase = getPhaseForDate(cursor, config);
        ensureDateWithinFocusPeriod(cursor, phase, config);
        const dateKey = formatDateKey(cursor);
        const startKey = formatTime(cursor).replace(":", "");
        const slotId = `${professorId}_${dateKey}_${startKey}`;

        const existing = await client.query(`
          SELECT status FROM availability_slots WHERE id = $1 FOR UPDATE
        `, [slotId]);

        if (!existing.rows[0] || existing.rows[0].status === STATUS.OPEN) {
          await client.query(`
            INSERT INTO availability_slots (
              id, professor_id, professor_name, professor_phone, department_name,
              date_key, phase, status, reservation_id, start_at, end_at, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, $10, NOW())
            ON CONFLICT (id)
            DO UPDATE SET
              professor_id = EXCLUDED.professor_id,
              professor_name = EXCLUDED.professor_name,
              professor_phone = EXCLUDED.professor_phone,
              department_name = EXCLUDED.department_name,
              date_key = EXCLUDED.date_key,
              phase = EXCLUDED.phase,
              status = EXCLUDED.status,
              start_at = EXCLUDED.start_at,
              end_at = EXCLUDED.end_at,
              updated_at = NOW()
            WHERE availability_slots.status = 'open'
          `, [
            slotId,
            professorId,
            professor.name,
            professor.phone,
            professor.departmentName,
            dateKey,
            phase,
            STATUS.OPEN,
            cursor.toISOString(),
            next.toISOString(),
          ]);
          slotCount += 1;
        }

        cursor = next;
      }
    }

    await client.query("COMMIT");
    return {ok: true, slotCount};
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function createReservation(data) {
  const slotId = ensureString(data.slotId, "slotId");
  const requestedProfessorId = ensureString(data.professorId, "professorId");
  const studentName = ensureString(data.studentName, "studentName");
  const studentNo = ensureString(data.studentNo, "studentNo");
  const phone = ensureString(data.phone, "phone");
  const note = String(data.note || "").trim();
  const phoneLast4 = maskPhoneLast4(phone);
  const reservationId = crypto.randomUUID();
  const baseLookupUrl = ensureString(data.lookupBaseUrl || process.env.FRONTEND_URL || "http://localhost:5000/", "lookupBaseUrl");
  const config = await getPublicConfig();

  const client = await pool.connect();
  let createdPhase = null;
  let createdProfessorId = null;
  try {
    await client.query("BEGIN");
    const slotResult = await client.query(`
      SELECT *
      FROM availability_slots
      WHERE id = $1
      FOR UPDATE
    `, [slotId]);

    const slot = slotResult.rows[0];
    if (!slot) {
      throw new AppError(404, "not-found", "선택한 상담 시간이 없습니다.");
    }
    if (slot.professor_id !== requestedProfessorId) {
      throw new AppError(400, "failed-precondition", "선택한 지도교수와 예약 시간이 일치하지 않습니다. 다시 선택해 주세요.");
    }
    await assertProfessorAssignment(studentNo, slot.professor_id, client);
    if (slot.status !== STATUS.OPEN) {
      throw new AppError(400, "failed-precondition", "이미 예약이 진행 중인 시간입니다.");
    }

    createdPhase = slot.phase;
    createdProfessorId = slot.professor_id;
    const activeResult = await client.query(`
      SELECT id
      FROM reservations
      WHERE student_no = $1
        AND professor_id = $2
        AND phase = $3
        AND status = ANY($4::text[])
      LIMIT 1
    `, [studentNo, slot.professor_id, slot.phase, [STATUS.PENDING, STATUS.APPROVED]]);

    if (activeResult.rows[0]) {
      throw new AppError(409, "already-exists", `${slot.phase}차 상담은 이미 신청 또는 확정되었습니다.`);
    }

    await client.query(`
      INSERT INTO reservations (
        id, slot_id, phase, status, student_name, student_no, phone, phone_last4,
        note, professor_id, professor_phone, professor_name, department_name,
        semester_label, start_at, end_at, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW(), NOW())
    `, [
      reservationId,
      slotId,
      slot.phase,
      STATUS.PENDING,
      studentName,
      studentNo,
      phone,
      phoneLast4,
      note,
      slot.professor_id,
      slot.professor_phone,
      slot.professor_name,
      slot.department_name || "",
      config.semesterLabel,
      slot.start_at,
      slot.end_at,
    ]);

    await client.query(`
      UPDATE availability_slots
      SET status = $2, reservation_id = $3, updated_at = NOW()
      WHERE id = $1
    `, [slotId, STATUS.PENDING, reservationId]);

    await client.query(`
      UPDATE alternate_requests
      SET status = $4, updated_at = NOW()
      WHERE student_no = $1
        AND professor_id = $2
        AND phase = $3
        AND status = $5
    `, [studentNo, createdProfessorId, createdPhase, ALT_STATUS.HANDLED, ALT_STATUS.REQUESTED]);

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const lookupUrl = new URL(baseLookupUrl);
  lookupUrl.searchParams.set("studentNo", studentNo);
  lookupUrl.searchParams.set("professorId", createdProfessorId);

  return {
    ok: true,
    reservationId,
    status: STATUS.PENDING,
    statusLabel: reservationStatusLabel(STATUS.PENDING),
    lookupUrl: lookupUrl.toString(),
    phoneLast4,
  };
}

async function createAlternateRequest(data) {
  const professorId = ensureString(data.professorId, "professorId");
  const studentName = ensureString(data.studentName, "studentName");
  const studentNo = ensureString(data.studentNo, "studentNo");
  const phone = ensureString(data.phone, "phone");
  const preferredTimeText = ensureString(data.preferredTimeText, "preferredTimeText");
  const reason = String(data.reason || "").trim();
  const phase = Number(data.phase);
  const phoneLast4 = maskPhoneLast4(phone);
  const config = await getPublicConfig();
  const professor = getProfessorById(config, professorId);

  if (!professor) {
    throw new AppError(404, "not-found", "지도교수 정보를 찾을 수 없습니다.");
  }
  if (![1, 2].includes(phase)) {
    throw new AppError(400, "invalid-argument", "상담 회차를 선택해 주세요.");
  }
  await assertProfessorAssignment(studentNo, professorId);

  const client = await pool.connect();
  try {
    const activeReservation = await client.query(`
      SELECT id
      FROM reservations
      WHERE student_no = $1
        AND professor_id = $2
        AND phase = $3
        AND status = ANY($4::text[])
      LIMIT 1
    `, [studentNo, professorId, phase, [STATUS.PENDING, STATUS.APPROVED]]);
    if (activeReservation.rows[0]) {
      throw new AppError(409, "already-exists", `${phase}차 상담은 이미 신청 또는 확정되었습니다.`);
    }

    const activeRequest = await client.query(`
      SELECT id
      FROM alternate_requests
      WHERE student_no = $1
        AND professor_id = $2
        AND phase = $3
        AND status = $4
      LIMIT 1
    `, [studentNo, professorId, phase, ALT_STATUS.REQUESTED]);
    if (activeRequest.rows[0]) {
      throw new AppError(409, "already-exists", "이미 대체면담 요청이 접수되어 있습니다.");
    }

    const requestId = crypto.randomUUID();
    await client.query(`
      INSERT INTO alternate_requests (
        id, student_name, student_no, phone, phone_last4, professor_id,
        phase, preferred_time_text, reason, status, professor_phone, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
    `, [
      requestId,
      studentName,
      studentNo,
      phone,
      phoneLast4,
      professorId,
      phase,
      preferredTimeText,
      reason,
      ALT_STATUS.REQUESTED,
      professor.phone,
    ]);

    return {
      ok: true,
      requestId,
      status: ALT_STATUS.REQUESTED,
      statusLabel: alternateRequestStatusLabel(ALT_STATUS.REQUESTED),
    };
  } finally {
    client.release();
  }
}

async function createOpenCounselRequest(data) {
  const professorId = ensureString(data.professorId, "professorId");
  const studentName = ensureString(data.studentName, "studentName");
  const studentNo = ensureString(data.studentNo, "studentNo");
  const phone = ensureString(data.phone, "phone");
  const preferredTimeText = ensureString(data.preferredTimeText, "preferredTimeText");
  const topic = ensureString(data.topic, "topic");
  const reason = String(data.reason || "").trim();
  const phoneLast4 = maskPhoneLast4(phone);
  const config = await getPublicConfig();
  const professor = getProfessorById(config, professorId);

  if (!professor) {
    throw new AppError(404, "not-found", "지도교수 정보를 찾을 수 없습니다.");
  }
  await assertProfessorAssignment(studentNo, professorId);

  const activeRequest = await pool.query(`
    SELECT id
    FROM open_counsel_requests
    WHERE student_no = $1
      AND professor_id = $2
      AND status = $3
    LIMIT 1
  `, [studentNo, professorId, ALT_STATUS.REQUESTED]);
  if (activeRequest.rows[0]) {
    throw new AppError(409, "already-exists", "이미 수시면담 요청이 접수되어 있습니다.");
  }

  const requestId = crypto.randomUUID();
  await pool.query(`
    INSERT INTO open_counsel_requests (
      id, student_name, student_no, phone, phone_last4, professor_id,
      preferred_time_text, topic, reason, status, professor_phone, created_at, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
  `, [
    requestId,
    studentName,
    studentNo,
    phone,
    phoneLast4,
    professorId,
    preferredTimeText,
    topic,
    reason,
    ALT_STATUS.REQUESTED,
    professor.phone,
  ]);

  return {
    ok: true,
    requestId,
    status: ALT_STATUS.REQUESTED,
    statusLabel: openCounselStatusLabel(ALT_STATUS.REQUESTED),
  };
}

async function lookupReservations(data) {
  const studentName = ensureString(data.studentName, "studentName");
  const studentNo = ensureString(data.studentNo, "studentNo");
  const phoneLast4 = ensureString(data.phoneLast4, "phoneLast4");

  const [reservationRows, alternateRows, openRows] = await Promise.all([
    pool.query(`
      SELECT *
      FROM reservations
      WHERE student_no = $1
      ORDER BY start_at DESC
    `, [studentNo]),
    pool.query(`
      SELECT *
      FROM alternate_requests
      WHERE student_no = $1
      ORDER BY created_at DESC
    `, [studentNo]),
    pool.query(`
      SELECT *
      FROM open_counsel_requests
      WHERE student_no = $1
      ORDER BY created_at DESC
    `, [studentNo]),
  ]);

  return {
    reservations: reservationRows.rows
      .filter((row) => row.student_name === studentName && row.phone_last4 === phoneLast4)
      .map(serializeReservation),
    alternateRequests: alternateRows.rows
      .filter((row) => row.student_name === studentName && row.phone_last4 === phoneLast4)
      .map(serializeAlternateRequest),
    openCounselRequests: openRows.rows
      .filter((row) => row.student_name === studentName && row.phone_last4 === phoneLast4)
      .map(serializeOpenCounselRequest),
  };
}

async function getProfessorDashboard(data) {
  const professorId = ensureString(data.professorId, "professorId");
  await requireProfessorCode(professorId, data && data.adminCode);

  const [config, studentRoster, reservationRows, slotRows, alternateRows, openRows] = await Promise.all([
    getPublicConfig(),
    getStudentRoster(),
    pool.query("SELECT * FROM reservations WHERE professor_id = $1 ORDER BY start_at ASC", [professorId]),
    pool.query("SELECT * FROM availability_slots WHERE professor_id = $1 ORDER BY start_at ASC", [professorId]),
    pool.query("SELECT * FROM alternate_requests WHERE professor_id = $1 ORDER BY created_at DESC", [professorId]),
    pool.query("SELECT * FROM open_counsel_requests WHERE professor_id = $1 ORDER BY created_at DESC", [professorId]),
  ]);

  return {
    config,
    professor: getProfessorById(config, professorId),
    studentRoster: filterStudentRosterForProfessor(studentRoster, professorId, config),
    reservations: reservationRows.rows.map(serializeReservation),
    alternateRequests: alternateRows.rows.map(serializeAlternateRequest),
    openCounselRequests: openRows.rows.map(serializeOpenCounselRequest),
    slots: slotRows.rows.map(serializeSlot),
  };
}

async function getSystemDashboard(data) {
  await requireSystemAdminCode(data && data.adminCode);
  const [config, studentRoster] = await Promise.all([
    getPublicConfig(),
    getStudentRoster(),
  ]);
  return {
    config,
    studentRoster,
    professors: getProfessorList(config),
  };
}

async function reviewAlternateRequest(data) {
  const professorId = ensureString(data.professorId, "professorId");
  await requireProfessorCode(professorId, data && data.adminCode);
  const requestId = ensureString(data.requestId, "requestId");
  const decision = ensureString(data.decision, "decision");

  if (![ALT_STATUS.HANDLED, ALT_STATUS.CANCELLED].includes(decision)) {
    throw new AppError(400, "invalid-argument", "지원하지 않는 처리 상태입니다.");
  }

  const result = await pool.query(`
    UPDATE alternate_requests
    SET status = $2, updated_at = NOW()
    WHERE id = $1 AND professor_id = $3
    RETURNING id
  `, [requestId, decision, professorId]);
  if (!result.rows[0]) {
    throw new AppError(403, "permission-denied", "다른 지도교수의 요청은 처리할 수 없습니다.");
  }
  return {ok: true};
}

async function reviewOpenCounselRequest(data) {
  const professorId = ensureString(data.professorId, "professorId");
  await requireProfessorCode(professorId, data && data.adminCode);
  const requestId = ensureString(data.requestId, "requestId");
  const decision = ensureString(data.decision, "decision");

  if (![ALT_STATUS.HANDLED, ALT_STATUS.CANCELLED].includes(decision)) {
    throw new AppError(400, "invalid-argument", "지원하지 않는 처리 상태입니다.");
  }

  const result = await pool.query(`
    UPDATE open_counsel_requests
    SET status = $2, updated_at = NOW()
    WHERE id = $1 AND professor_id = $3
    RETURNING id
  `, [requestId, decision, professorId]);
  if (!result.rows[0]) {
    throw new AppError(403, "permission-denied", "다른 지도교수의 요청은 처리할 수 없습니다.");
  }
  return {ok: true};
}

async function reviewReservation(data) {
  const professorId = ensureString(data.professorId, "professorId");
  await requireProfessorCode(professorId, data && data.adminCode);
  const reservationId = ensureString(data.reservationId, "reservationId");
  const decision = ensureString(data.decision, "decision");
  const reviewNote = String(data.reviewNote || "").trim();

  if (![STATUS.APPROVED, STATUS.REJECTED, STATUS.CANCELLED, STATUS.NO_ANSWER].includes(decision)) {
    throw new AppError(400, "invalid-argument", "지원하지 않는 처리 상태입니다.");
  }

  const client = await pool.connect();
  let approvedReservation = null;
  try {
    await client.query("BEGIN");

    const reservationResult = await client.query(`
      SELECT *
      FROM reservations
      WHERE id = $1
      FOR UPDATE
    `, [reservationId]);
    const reservation = reservationResult.rows[0];
    if (!reservation) {
      throw new AppError(404, "not-found", "예약 정보가 없습니다.");
    }
    if (reservation.professor_id !== professorId) {
      throw new AppError(403, "permission-denied", "다른 지도교수의 예약은 처리할 수 없습니다.");
    }

    const slotResult = await client.query(`
      SELECT *
      FROM availability_slots
      WHERE id = $1
      FOR UPDATE
    `, [reservation.slot_id]);
    const slot = slotResult.rows[0];
    if (!slot) {
      throw new AppError(404, "not-found", "상담 슬롯 정보가 없습니다.");
    }

    let nextSlotStatus = STATUS.OPEN;
    if (decision === STATUS.APPROVED) {
      nextSlotStatus = STATUS.CONFIRMED;
    } else if (decision === STATUS.NO_ANSWER) {
      nextSlotStatus = STATUS.NO_ANSWER;
    }

    await client.query(`
      UPDATE reservations
      SET status = $2, review_note = $3, reviewed_at = NOW(), updated_at = NOW()
      WHERE id = $1
    `, [reservationId, decision, reviewNote]);

    await client.query(`
      UPDATE availability_slots
      SET status = $2, reservation_id = $3, updated_at = NOW()
      WHERE id = $1
    `, [
      reservation.slot_id,
      nextSlotStatus,
      decision === STATUS.APPROVED || decision === STATUS.NO_ANSWER ? reservationId : null,
    ]);

    if (decision === STATUS.APPROVED) {
      approvedReservation = reservation;
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  let smsResult = {sent: false};
  if (decision === STATUS.APPROVED && approvedReservation) {
    const start = new Date(approvedReservation.start_at);
    const end = new Date(approvedReservation.end_at);
    const dateText = `${formatDateKey(start)} ${formatTime(start)}~${formatTime(end)}`;
    const roundText = `${approvedReservation.phase}차 면담`;
    const studentBody = `${approvedReservation.student_name} 학생의 전화면담이 확정되었습니다. 일시: ${dateText} 지도교수 전화: ${approvedReservation.professor_phone} 상담 회차: ${roundText}`;
    const professorBody = `${approvedReservation.student_name}(${approvedReservation.student_no}) 학생 전화면담이 확정되었습니다. 일시: ${dateText} 학생 연락처 ${approvedReservation.phone}`;
    smsResult = await sendSmsMessages([
      {to: approvedReservation.phone, body: studentBody},
      {to: approvedReservation.professor_phone, body: professorBody},
    ]);
  }

  return {ok: true, smsResult};
}

async function getPublicConfigDoc() {
  return getPublicConfig();
}

async function getPublicSlots() {
  const {rows} = await pool.query(`
    SELECT *
    FROM availability_slots
    ORDER BY start_at ASC
  `);
  return rows.map(serializeSlot);
}

const callableHandlers = {
  bootstrapConfig,
  createAlternateRequest,
  createOpenCounselRequest,
  createReservation,
  getProfessorDashboard,
  getSystemDashboard,
  lookupReservations,
  reviewAlternateRequest,
  reviewOpenCounselRequest,
  reviewReservation,
  updateAdminCode,
  updateProfessorDirectory,
  updatePublicConfig,
  updateStudentRoster,
  upsertAvailability,
};

function buildFirestoreTimestampLike(isoString) {
  return {
    toDate() {
      return new Date(isoString);
    },
  };
}

const app = express();
app.use(cors({
  origin: process.env.APP_ORIGIN ? process.env.APP_ORIGIN.split(",").map((item) => item.trim()) : true,
  credentials: false,
}));
app.use(express.json({limit: "1mb"}));

const publicDir = path.resolve(__dirname, "..", "public");
app.use(express.static(publicDir));

app.get("/health", async (_req, res, next) => {
  try {
    await pool.query("SELECT 1");
    res.json({ok: true});
  } catch (error) {
    next(error);
  }
});

app.get("/api/public/config", async (_req, res, next) => {
  try {
    res.json(await getPublicConfigDoc());
  } catch (error) {
    next(error);
  }
});

app.get("/api/public/slots", async (_req, res, next) => {
  try {
    res.json(await getPublicSlots());
  } catch (error) {
    next(error);
  }
});

app.post("/api/call/:name", async (req, res, next) => {
  try {
    const handler = callableHandlers[req.params.name];
    if (!handler) {
      throw new AppError(404, "not-found", "API를 찾을 수 없습니다.");
    }
    const result = await handler(req.body || {});
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.use((error, _req, res, _next) => {
  if (error instanceof AppError) {
    res.status(error.statusCode).json({
      error: {
        status: error.code,
        message: error.message,
      },
    });
    return;
  }

  console.error(error);
  res.status(500).json({
    error: {
      status: "internal",
      message: "서버 처리 중 오류가 발생했습니다.",
    },
  });
});

async function start() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL 환경변수가 필요합니다.");
  }
  await initializeSchema();
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});

module.exports = {
  buildFirestoreTimestampLike,
};
