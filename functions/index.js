"use strict";

const admin = require("firebase-admin");
const functions = require("firebase-functions");

admin.initializeApp();

const db = admin.firestore();
const REGION = "asia-northeast3";
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
const DEFAULT_PUBLIC_CONFIG = {
  semesterLabel: "2026학년도 1학기",
  semesterStartDate: "2026-03-02",
  midtermDate: "2026-04-20",
  finalDate: "2026-06-15",
  firstRoundFocusStartDate: "2026-03-02",
  firstRoundFocusEndDate: "2026-04-19",
  secondRoundFocusStartDate: "2026-04-20",
  secondRoundFocusEndDate: "2026-06-14",
  professorName: "지도교수",
  professorPhone: "010-0000-0000",
  departmentName: "원격수업 학생상담",
  professors: [
    {
      id: "prof-1",
      name: "지도교수",
      phone: "010-0000-0000",
      departmentName: "원격수업 학생상담",
      active: true,
    },
  ],
  supportMessage: "예약 확정 시 교수와 학생에게 문자 알림이 발송됩니다.",
  adminCode: "1234",
};

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
  const digits = normalizePhone(phone);
  return digits.slice(-4);
}

function ensureString(value, field) {
  if (!value || typeof value !== "string") {
    throw new functions.https.HttpsError("invalid-argument", `${field} 값이 필요합니다.`);
  }
  return value.trim();
}

async function getPublicConfig() {
  const snapshot = await db.collection("publicConfig").doc("general").get();
  if (!snapshot.exists) {
    const config = {...DEFAULT_PUBLIC_CONFIG};
    delete config.adminCode;
    return config;
  }
  const data = snapshot.data();
  if (!Array.isArray(data.professors) || !data.professors.length) {
    data.professors = DEFAULT_PUBLIC_CONFIG.professors;
  }
  return data;
}

async function getPrivateConfig() {
  const snapshot = await db.collection("publicConfig").doc("private").get();
  if (snapshot.exists) {
    const data = snapshot.data();
    return {
      ...data,
      systemAdminCode: data.systemAdminCode || data.adminCode || DEFAULT_PUBLIC_CONFIG.adminCode,
      professorAdminCodes: data.professorAdminCodes || {
        "prof-1": data.adminCode || DEFAULT_PUBLIC_CONFIG.adminCode,
      },
    };
  }
  return {
    adminCode: DEFAULT_PUBLIC_CONFIG.adminCode,
    systemAdminCode: DEFAULT_PUBLIC_CONFIG.adminCode,
    professorAdminCodes: {
      "prof-1": DEFAULT_PUBLIC_CONFIG.adminCode,
    },
  };
}

async function getStudentRoster() {
  const snapshot = await db.collection("adminData").doc("studentRoster").get();
  if (!snapshot.exists) {
    return [];
  }
  const entries = snapshot.data().entries;
  return Array.isArray(entries) ? entries : [];
}

function filterStudentRosterForProfessor(studentRoster, professorId, config) {
  const activeProfessors = getProfessorList(config).filter((item) => item.active !== false);
  if (activeProfessors.length <= 1) {
    return studentRoster;
  }
  return studentRoster.filter((student) => student.professorId === professorId);
}

async function assertProfessorAssignment(studentNo, professorId) {
  const studentRoster = await getStudentRoster();
  const student = studentRoster.find((entry) => entry.studentNo === studentNo);
  if (student && student.professorId && student.professorId !== professorId) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "해당 학생은 다른 지도교수에게 배정되어 있습니다. 배정된 지도교수로 신청해 주세요.",
    );
  }
}

function getProfessorList(config) {
  return Array.isArray(config.professors) ? config.professors.filter((item) => item && item.id) : [];
}

function getProfessorById(config, professorId) {
  return getProfessorList(config).find((professor) => professor.id === professorId && professor.active !== false) || null;
}

async function requireSystemAdminCode(code) {
  const submitted = ensureString(code, "adminCode");
  const privateConfig = await getPrivateConfig();
  const savedCode = privateConfig.systemAdminCode || privateConfig.adminCode || DEFAULT_PUBLIC_CONFIG.adminCode;
  if (submitted !== savedCode) {
    throw new functions.https.HttpsError("permission-denied", "관리자 인증에 실패했습니다.");
  }
}

async function requireProfessorCode(professorId, code) {
  const submitted = ensureString(code, "adminCode");
  const privateConfig = await getPrivateConfig();
  const codes = privateConfig.professorAdminCodes || {};
  const savedCode = codes[professorId];
  if (!savedCode || submitted !== savedCode) {
    throw new functions.https.HttpsError("permission-denied", "지도교수 인증에 실패했습니다.");
  }
}

function getPhaseForDate(date, config) {
  const semesterStart = getKstDate(config.semesterStartDate, "00:00");
  const midtermStart = getKstDate(config.midtermDate, "00:00");
  const finalStart = getKstDate(config.finalDate, "00:00");

  if (date < semesterStart || date >= finalStart) {
    throw new functions.https.HttpsError("failed-precondition", "학기 상담 가능 기간 밖의 일정입니다.");
  }
  if (date < midtermStart) {
    return 1;
  }
  return 2;
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
    throw new functions.https.HttpsError(
      "failed-precondition",
      `${phase}차 상담 시간은 집중면담기간 안에서만 등록할 수 있습니다.`,
    );
  }
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
    return "수시면담 신청접수";
  }
  if (status === ALT_STATUS.HANDLED) {
    return "수시면담 조율완료";
  }
  return "수시면담 취소";
}

function sanitizeRosterEntries(entries, config) {
  if (!Array.isArray(entries)) {
    throw new functions.https.HttpsError("invalid-argument", "학생 명단 형식이 올바르지 않습니다.");
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
      throw new functions.https.HttpsError(
        "invalid-argument",
        `${studentNo} 학생의 지도교수 ID가 비어 있습니다. 다수 지도교수 사용 시 학생별 교수 ID를 함께 등록해야 합니다.`,
      );
    }
    if (professorId && !professorIds.includes(professorId)) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        `${studentNo} 학생의 지도교수 ID가 교수 목록에 없습니다: ${professorId}`,
      );
    }

    if (seen.has(studentNo)) {
      throw new functions.https.HttpsError("already-exists", `중복 학번이 있습니다: ${studentNo}`);
    }
    seen.add(studentNo);

    return {
      studentNo,
      studentName,
      phone,
      professorId,
    };
  });
}

function sanitizeProfessorDirectory(entries, existingCodes = {}) {
  if (!Array.isArray(entries) || !entries.length) {
    throw new functions.https.HttpsError("invalid-argument", "교수 목록이 비어 있습니다.");
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
      throw new functions.https.HttpsError("already-exists", `중복 교수 ID가 있습니다: ${id}`);
    }
    if (!adminCode) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        `${id} 교수의 로그인 코드가 비어 있습니다. 새 교수 추가 시 코드 입력이 필요합니다.`,
      );
    }
    ids.add(id);

    publicProfessors.push({
      id,
      name,
      phone,
      departmentName,
      active,
    });
    professorAdminCodes[id] = adminCode;
  });

  return {
    publicProfessors,
    professorAdminCodes,
  };
}

async function sendSmsMessages(messages) {
  const runtimeConfig = functions.config();
  const sid = runtimeConfig.twilio && runtimeConfig.twilio.account_sid;
  const token = runtimeConfig.twilio && runtimeConfig.twilio.auth_token;
  const sender = runtimeConfig.twilio && runtimeConfig.twilio.phone_number;

  if (!sid || !token || !sender) {
    console.log("Twilio runtime config is not configured. Skipping SMS send.");
    return {sent: false, reason: "twilio_not_configured"};
  }

  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const results = [];

  for (const message of messages) {
    const body = new URLSearchParams({
      To: message.to,
      From: sender,
      Body: message.body,
    });

    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("Twilio send failed:", text);
      throw new functions.https.HttpsError("internal", "문자 발송에 실패했습니다.");
    }

    const data = await response.json();
    results.push({sid: data.sid, to: message.to});
  }

  return {sent: true, results};
}

function serializeReservation(doc) {
  const data = doc.data();
  return {
    id: doc.id,
    slotId: data.slotId,
    professorId: data.professorId || "",
    phase: data.phase,
    status: data.status,
    studentName: data.studentName,
    studentNo: data.studentNo,
    phone: data.phone,
    phoneLast4: data.phoneLast4,
    note: data.note || "",
    professorName: data.professorName,
    professorPhone: data.professorPhone,
    departmentName: data.departmentName || "",
    semesterLabel: data.semesterLabel,
    startAt: data.startAt.toDate().toISOString(),
    endAt: data.endAt.toDate().toISOString(),
    statusLabel: reservationStatusLabel(data.status),
  };
}

function serializeAlternateRequest(doc) {
  const data = doc.data();
  return {
    id: doc.id,
    professorId: data.professorId || "",
    phase: data.phase,
    status: data.status,
    studentName: data.studentName,
    studentNo: data.studentNo,
    phone: data.phone,
    phoneLast4: data.phoneLast4,
    preferredTimeText: data.preferredTimeText || "",
    reason: data.reason || "",
    professorPhone: data.professorPhone,
    createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null,
    updatedAt: data.updatedAt ? data.updatedAt.toDate().toISOString() : null,
    statusLabel: alternateRequestStatusLabel(data.status),
  };
}

function serializeOpenCounselRequest(doc) {
  const data = doc.data();
  return {
    id: doc.id,
    professorId: data.professorId || "",
    status: data.status,
    studentName: data.studentName,
    studentNo: data.studentNo,
    phone: data.phone,
    phoneLast4: data.phoneLast4,
    preferredTimeText: data.preferredTimeText || "",
    topic: data.topic || "",
    reason: data.reason || "",
    professorPhone: data.professorPhone,
    createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null,
    updatedAt: data.updatedAt ? data.updatedAt.toDate().toISOString() : null,
    statusLabel: openCounselStatusLabel(data.status),
  };
}

exports.bootstrapConfig = functions.region(REGION).https.onCall(async (data) => {
  await requireSystemAdminCode(data && data.adminCode);
  const publicRef = db.collection("publicConfig").doc("general");
  const privateRef = db.collection("publicConfig").doc("private");
  const publicSnapshot = await publicRef.get();
  const privateSnapshot = await privateRef.get();

  if (!publicSnapshot.exists) {
    const config = {...DEFAULT_PUBLIC_CONFIG};
    delete config.adminCode;
    await publicRef.set(config);
  }

  if (!privateSnapshot.exists) {
    await privateRef.set({
      adminCode: DEFAULT_PUBLIC_CONFIG.adminCode,
      systemAdminCode: DEFAULT_PUBLIC_CONFIG.adminCode,
      professorAdminCodes: {
        "prof-1": DEFAULT_PUBLIC_CONFIG.adminCode,
      },
    });
  }

  return {ok: true};
});

exports.updatePublicConfig = functions.region(REGION).https.onCall(async (data) => {
  await requireSystemAdminCode(data && data.adminCode);

  const nextConfig = {
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
    throw new functions.https.HttpsError("invalid-argument", "학기 시작일, 중간고사일, 기말고사일 순서를 확인해주세요.");
  }
  if (!(start <= firstFocusStart && firstFocusStart <= firstFocusEnd && firstFocusEnd < midterm)) {
    throw new functions.https.HttpsError("invalid-argument", "1차 집중면담기간은 개강일부터 중간고사 시작일 전까지 설정해주세요.");
  }
  if (!(midterm <= secondFocusStart && secondFocusStart <= secondFocusEnd && secondFocusEnd < finalDate)) {
    throw new functions.https.HttpsError("invalid-argument", "2차 집중면담기간은 중간고사 시작일부터 기말고사 시작일 전까지 설정해주세요.");
  }
  if (firstFocusDays > FOCUS_PERIOD_MAX_DAYS) {
    throw new functions.https.HttpsError("invalid-argument", `1차 집중면담기간은 ${FOCUS_PERIOD_MAX_DAYS}일 이내로 설정해주세요.`);
  }
  if (secondFocusDays > FOCUS_PERIOD_MAX_DAYS) {
    throw new functions.https.HttpsError("invalid-argument", `2차 집중면담기간은 ${FOCUS_PERIOD_MAX_DAYS}일 이내로 설정해주세요.`);
  }

  await db.collection("publicConfig").doc("general").set(nextConfig, {merge: true});
  return {ok: true};
});

exports.updateAdminCode = functions.region(REGION).https.onCall(async (data) => {
  await requireSystemAdminCode(data && data.adminCode);
  const nextCode = ensureString(data.nextAdminCode, "nextAdminCode");
  await db.collection("publicConfig").doc("private").set({
    adminCode: nextCode,
    systemAdminCode: nextCode,
  }, {merge: true});
  return {ok: true};
});

exports.updateStudentRoster = functions.region(REGION).https.onCall(async (data) => {
  await requireSystemAdminCode(data && data.adminCode);
  const config = await getPublicConfig();
  const entries = sanitizeRosterEntries(data && data.entries, config);
  await db.collection("adminData").doc("studentRoster").set({
    entries,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return {
    ok: true,
    count: entries.length,
  };
});

exports.updateProfessorDirectory = functions.region(REGION).https.onCall(async (data) => {
  await requireSystemAdminCode(data && data.adminCode);
  const privateConfig = await getPrivateConfig();
  const sanitized = sanitizeProfessorDirectory(
    data && data.entries,
    privateConfig.professorAdminCodes || {},
  );
  await db.collection("publicConfig").doc("general").set({
    professors: sanitized.publicProfessors,
  }, {merge: true});
  await db.collection("publicConfig").doc("private").set({
    professorAdminCodes: sanitized.professorAdminCodes,
  }, {merge: true});
  return {
    ok: true,
    count: sanitized.publicProfessors.length,
  };
});

exports.upsertAvailability = functions.region(REGION).https.onCall(async (data) => {
  const professorId = ensureString(data.professorId, "professorId");
  await requireProfessorCode(professorId, data && data.adminCode);
  const entries = Array.isArray(data.entries) ? data.entries : [];
  if (!entries.length) {
    throw new functions.https.HttpsError("invalid-argument", "추가할 가능 시간대가 없습니다.");
  }

  const config = await getPublicConfig();
  const professor = getProfessorById(config, professorId);
  if (!professor) {
    throw new functions.https.HttpsError("not-found", "지도교수 정보를 찾을 수 없습니다.");
  }
  const batch = db.batch();
  let slotCount = 0;

  for (const entry of entries) {
    const date = ensureString(entry.date, "date");
    const startTime = ensureString(entry.startTime, "startTime");
    const endTime = ensureString(entry.endTime, "endTime");
    let cursor = getKstDate(date, startTime);
    const end = getKstDate(date, endTime);

    if (!(cursor < end)) {
      throw new functions.https.HttpsError("invalid-argument", "상담 종료 시간이 시작 시간보다 늦어야 합니다.");
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
      const slotRef = db.collection("availabilitySlots").doc(slotId);
      const slotSnapshot = await slotRef.get();

      if (!slotSnapshot.exists || slotSnapshot.data().status === STATUS.OPEN) {
        batch.set(slotRef, {
          professorId,
          professorName: professor.name,
          professorPhone: professor.phone,
          departmentName: professor.departmentName,
          dateKey,
          phase,
          status: STATUS.OPEN,
          startAt: admin.firestore.Timestamp.fromDate(cursor),
          endAt: admin.firestore.Timestamp.fromDate(next),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, {merge: true});
        slotCount += 1;
      }

      cursor = next;
    }
  }

  await batch.commit();
  return {ok: true, slotCount};
});

exports.createReservation = functions.region(REGION).https.onCall(async (data) => {
  const slotId = ensureString(data.slotId, "slotId");
  const requestedProfessorId = ensureString(data.professorId, "professorId");
  const studentName = ensureString(data.studentName, "studentName");
  const studentNo = ensureString(data.studentNo, "studentNo");
  const phone = ensureString(data.phone, "phone");
  const note = String(data.note || "").trim();
  const phoneLast4 = maskPhoneLast4(phone);
  const reservationRef = db.collection("reservations").doc();
  const slotRef = db.collection("availabilitySlots").doc(slotId);
  const config = await getPublicConfig();
  const baseLookupUrl = ensureString(data.lookupBaseUrl || "https://online-meeting-time.web.app/", "lookupBaseUrl");
  let createdPhase = null;
  let createdProfessorId = null;

  await db.runTransaction(async (transaction) => {
    const slotSnapshot = await transaction.get(slotRef);
    if (!slotSnapshot.exists) {
      throw new functions.https.HttpsError("not-found", "선택한 상담 시간이 없습니다.");
    }

    const slot = slotSnapshot.data();
    if (slot.professorId !== requestedProfessorId) {
      throw new functions.https.HttpsError("failed-precondition", "선택한 지도교수와 예약 시간이 일치하지 않습니다. 다시 선택해 주세요.");
    }
    await assertProfessorAssignment(studentNo, slot.professorId);
    if (slot.status !== STATUS.OPEN) {
      throw new functions.https.HttpsError("failed-precondition", "이미 예약이 진행 중인 시간입니다.");
    }

    const phase = slot.phase;
    createdPhase = phase;
    createdProfessorId = slot.professorId;
    const activeQuery = db.collection("reservations")
      .where("studentNo", "==", studentNo)
      .where("professorId", "==", slot.professorId)
      .where("phase", "==", phase)
      .where("status", "in", [STATUS.PENDING, STATUS.APPROVED]);
    const activeSnapshots = await transaction.get(activeQuery);

    if (!activeSnapshots.empty) {
      throw new functions.https.HttpsError("already-exists", `${phase}차 상담은 이미 신청 또는 확정되었습니다.`);
    }

    transaction.set(reservationRef, {
      slotId,
      phase,
      status: STATUS.PENDING,
      studentName,
      studentNo,
      phone,
      phoneLast4,
      note,
      professorId: slot.professorId,
      professorPhone: slot.professorPhone,
      departmentName: slot.departmentName || "",
      professorName: slot.professorName,
      semesterLabel: config.semesterLabel,
      startAt: slot.startAt,
      endAt: slot.endAt,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    transaction.set(slotRef, {
      status: STATUS.PENDING,
      reservationId: reservationRef.id,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});
  });

  const lookupUrl = new URL(baseLookupUrl);
  lookupUrl.searchParams.set("studentNo", studentNo);
  lookupUrl.searchParams.set("professorId", createdProfessorId);

  const altRequests = await db.collection("alternateRequests")
    .where("studentNo", "==", studentNo)
    .where("professorId", "==", createdProfessorId)
    .where("phase", "==", createdPhase)
    .get();

  if (!altRequests.empty) {
    const batch = db.batch();
    altRequests.docs.forEach((doc) => {
      if (doc.data().status === ALT_STATUS.REQUESTED) {
        batch.set(doc.ref, {
          status: ALT_STATUS.HANDLED,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, {merge: true});
      }
    });
    await batch.commit();
  }

  return {
    ok: true,
    reservationId: reservationRef.id,
    status: STATUS.PENDING,
    statusLabel: reservationStatusLabel(STATUS.PENDING),
    lookupUrl: lookupUrl.toString(),
    phoneLast4,
  };
});

exports.createAlternateRequest = functions.region(REGION).https.onCall(async (data) => {
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
    throw new functions.https.HttpsError("not-found", "지도교수 정보를 찾을 수 없습니다.");
  }

  if (![1, 2].includes(phase)) {
    throw new functions.https.HttpsError("invalid-argument", "상담 회차를 선택해주세요.");
  }

  await assertProfessorAssignment(studentNo, professorId);

  const activeReservation = await db.collection("reservations")
    .where("studentNo", "==", studentNo)
    .where("professorId", "==", professorId)
    .where("phase", "==", phase)
    .where("status", "in", [STATUS.PENDING, STATUS.APPROVED])
    .get();
  if (!activeReservation.empty) {
    throw new functions.https.HttpsError("already-exists", `${phase}차 상담은 이미 신청 또는 확정되었습니다.`);
  }

  const activeAltRequest = await db.collection("alternateRequests")
    .where("studentNo", "==", studentNo)
    .where("professorId", "==", professorId)
    .where("phase", "==", phase)
    .where("status", "==", ALT_STATUS.REQUESTED)
    .get();
  if (!activeAltRequest.empty) {
    throw new functions.https.HttpsError("already-exists", "이미 대체 면담 요청이 접수되어 있습니다.");
  }

  const ref = db.collection("alternateRequests").doc();
  await ref.set({
    studentName,
    studentNo,
    phone,
    phoneLast4,
    professorId,
    preferredTimeText,
    reason,
    phase,
    status: ALT_STATUS.REQUESTED,
    professorPhone: professor.phone,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    ok: true,
    requestId: ref.id,
    status: ALT_STATUS.REQUESTED,
    statusLabel: alternateRequestStatusLabel(ALT_STATUS.REQUESTED),
  };
});

exports.createOpenCounselRequest = functions.region(REGION).https.onCall(async (data) => {
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
    throw new functions.https.HttpsError("not-found", "지도교수 정보를 찾을 수 없습니다.");
  }

  await assertProfessorAssignment(studentNo, professorId);

  const activeRequest = await db.collection("openCounselRequests")
    .where("studentNo", "==", studentNo)
    .where("professorId", "==", professorId)
    .where("status", "==", ALT_STATUS.REQUESTED)
    .get();
  if (!activeRequest.empty) {
    throw new functions.https.HttpsError("already-exists", "이미 수시면담 신청이 접수되어 있습니다.");
  }

  const ref = db.collection("openCounselRequests").doc();
  await ref.set({
    studentName,
    studentNo,
    phone,
    phoneLast4,
    professorId,
    preferredTimeText,
    topic,
    reason,
    status: ALT_STATUS.REQUESTED,
    professorPhone: professor.phone,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    ok: true,
    requestId: ref.id,
    status: ALT_STATUS.REQUESTED,
    statusLabel: openCounselStatusLabel(ALT_STATUS.REQUESTED),
  };
});

exports.lookupReservations = functions.region(REGION).https.onCall(async (data) => {
  const studentName = ensureString(data.studentName, "studentName");
  const studentNo = ensureString(data.studentNo, "studentNo");
  const phoneLast4 = ensureString(data.phoneLast4, "phoneLast4");

  const snapshot = await db.collection("reservations")
    .where("studentNo", "==", studentNo)
    .orderBy("startAt", "desc")
    .get();

  const reservations = snapshot.docs
    .filter((doc) => {
      const record = doc.data();
      return record.studentName === studentName && record.phoneLast4 === phoneLast4;
    })
    .map(serializeReservation);

  const alternateSnapshot = await db.collection("alternateRequests")
    .where("studentNo", "==", studentNo)
    .get();

  const alternateRequests = alternateSnapshot.docs
    .filter((doc) => {
      const record = doc.data();
      return record.studentName === studentName && record.phoneLast4 === phoneLast4;
    })
    .map(serializeAlternateRequest);

  const openCounselSnapshot = await db.collection("openCounselRequests")
    .where("studentNo", "==", studentNo)
    .get();

  const openCounselRequests = openCounselSnapshot.docs
    .filter((doc) => {
      const record = doc.data();
      return record.studentName === studentName && record.phoneLast4 === phoneLast4;
    })
    .map(serializeOpenCounselRequest);

  return {reservations, alternateRequests, openCounselRequests};
});

exports.getProfessorDashboard = functions.region(REGION).https.onCall(async (data) => {
  const professorId = ensureString(data.professorId, "professorId");
  await requireProfessorCode(professorId, data && data.adminCode);
  const [config, studentRoster, reservationsSnapshot, slotsSnapshot, alternateRequestsSnapshot, openCounselRequestsSnapshot] = await Promise.all([
    getPublicConfig(),
    getStudentRoster(),
    db.collection("reservations").where("professorId", "==", professorId).orderBy("startAt", "asc").get(),
    db.collection("availabilitySlots").where("professorId", "==", professorId).orderBy("startAt", "asc").get(),
    db.collection("alternateRequests").where("professorId", "==", professorId).orderBy("createdAt", "desc").get(),
    db.collection("openCounselRequests").where("professorId", "==", professorId).orderBy("createdAt", "desc").get(),
  ]);

  return {
    config,
    professor: getProfessorById(config, professorId),
    studentRoster: filterStudentRosterForProfessor(studentRoster, professorId, config),
    reservations: reservationsSnapshot.docs.map(serializeReservation),
    alternateRequests: alternateRequestsSnapshot.docs.map(serializeAlternateRequest),
    openCounselRequests: openCounselRequestsSnapshot.docs.map(serializeOpenCounselRequest),
    slots: slotsSnapshot.docs.map((doc) => {
      const slot = doc.data();
      return {
        id: doc.id,
        professorId: slot.professorId || "",
        professorName: slot.professorName || "",
        professorPhone: slot.professorPhone || "",
        departmentName: slot.departmentName || "",
        dateKey: slot.dateKey,
        phase: slot.phase,
        status: slot.status,
        reservationId: slot.reservationId || null,
        startAt: slot.startAt.toDate().toISOString(),
        endAt: slot.endAt.toDate().toISOString(),
      };
    }),
  };
});

exports.getSystemDashboard = functions.region(REGION).https.onCall(async (data) => {
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
});

exports.reviewAlternateRequest = functions.region(REGION).https.onCall(async (data) => {
  const professorId = ensureString(data.professorId, "professorId");
  await requireProfessorCode(professorId, data && data.adminCode);
  const requestId = ensureString(data.requestId, "requestId");
  const decision = ensureString(data.decision, "decision");

  if (![ALT_STATUS.HANDLED, ALT_STATUS.CANCELLED].includes(decision)) {
    throw new functions.https.HttpsError("invalid-argument", "지원하지 않는 처리 상태입니다.");
  }

  const requestRef = db.collection("alternateRequests").doc(requestId);
  const requestSnapshot = await requestRef.get();
  if (!requestSnapshot.exists || requestSnapshot.data().professorId !== professorId) {
    throw new functions.https.HttpsError("permission-denied", "다른 지도교수의 요청은 처리할 수 없습니다.");
  }

  await requestRef.set({
    status: decision,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, {merge: true});

  return {ok: true};
});

exports.reviewOpenCounselRequest = functions.region(REGION).https.onCall(async (data) => {
  const professorId = ensureString(data.professorId, "professorId");
  await requireProfessorCode(professorId, data && data.adminCode);
  const requestId = ensureString(data.requestId, "requestId");
  const decision = ensureString(data.decision, "decision");

  if (![ALT_STATUS.HANDLED, ALT_STATUS.CANCELLED].includes(decision)) {
    throw new functions.https.HttpsError("invalid-argument", "지원하지 않는 처리 상태입니다.");
  }

  const requestRef = db.collection("openCounselRequests").doc(requestId);
  const requestSnapshot = await requestRef.get();
  if (!requestSnapshot.exists || requestSnapshot.data().professorId !== professorId) {
    throw new functions.https.HttpsError("permission-denied", "다른 지도교수의 요청은 처리할 수 없습니다.");
  }

  await requestRef.set({
    status: decision,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, {merge: true});

  return {ok: true};
});

exports.reviewReservation = functions.region(REGION).https.onCall(async (data) => {
  const professorId = ensureString(data.professorId, "professorId");
  await requireProfessorCode(professorId, data && data.adminCode);
  const reservationId = ensureString(data.reservationId, "reservationId");
  const decision = ensureString(data.decision, "decision");
  const reviewNote = String(data.reviewNote || "").trim();

  if (![STATUS.APPROVED, STATUS.REJECTED, STATUS.CANCELLED, STATUS.NO_ANSWER].includes(decision)) {
    throw new functions.https.HttpsError("invalid-argument", "지원하지 않는 처리 상태입니다.");
  }

  const reservationRef = db.collection("reservations").doc(reservationId);

  let approvedReservation = null;
  await db.runTransaction(async (transaction) => {
    const reservationSnapshot = await transaction.get(reservationRef);
    if (!reservationSnapshot.exists) {
      throw new functions.https.HttpsError("not-found", "예약 정보가 없습니다.");
    }

    const reservation = reservationSnapshot.data();
    if (reservation.professorId !== professorId) {
      throw new functions.https.HttpsError("permission-denied", "다른 지도교수의 예약은 처리할 수 없습니다.");
    }
    const slotRef = db.collection("availabilitySlots").doc(reservation.slotId);
    const slotSnapshot = await transaction.get(slotRef);
    if (!slotSnapshot.exists) {
      throw new functions.https.HttpsError("not-found", "상담 슬롯 정보가 없습니다.");
    }

    let nextSlotStatus = STATUS.OPEN;
    if (decision === STATUS.APPROVED) {
      nextSlotStatus = STATUS.CONFIRMED;
    } else if (decision === STATUS.NO_ANSWER) {
      nextSlotStatus = STATUS.NO_ANSWER;
    }
    transaction.set(reservationRef, {
      status: decision,
      reviewNote,
      reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});

    transaction.set(slotRef, {
      status: nextSlotStatus,
      reservationId: decision === STATUS.APPROVED || decision === STATUS.NO_ANSWER ? reservationId : null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});

    if (decision === STATUS.APPROVED) {
      approvedReservation = reservation;
    }
  });

  let smsResult = {sent: false};
  if (decision === STATUS.APPROVED && approvedReservation) {
    const start = approvedReservation.startAt.toDate();
    const end = approvedReservation.endAt.toDate();
    const dateText = `${formatDateKey(start)} ${formatTime(start)}~${formatTime(end)}`;
    const roundText = `${approvedReservation.phase}차 면담`;
    const studentBody = `${approvedReservation.studentName} 학생의 전화면담이 확정되었습니다. 일시: ${dateText} 지도교수 전화: ${approvedReservation.professorPhone} 상담 회차: ${roundText}`;
    const professorBody = `${approvedReservation.studentName}(${approvedReservation.studentNo}) 학생 전화면담이 확정되었습니다. 일시: ${dateText} 학생 연락처: ${approvedReservation.phone}`;
    smsResult = await sendSmsMessages([
      {to: approvedReservation.phone, body: studentBody},
      {to: approvedReservation.professorPhone, body: professorBody},
    ]);
  }

  return {ok: true, smsResult};
});
