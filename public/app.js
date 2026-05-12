const STATUS_LABELS = {
  open: "예약가능",
  pending: "승인대기",
  approved: "면담확정",
  rejected: "반려/취소",
  cancelled: "반려/취소",
  confirmed: "면담확정",
  no_answer: "통화불가",
};

const ACTIVE_RESERVATION_STATUSES = new Set(["pending", "approved"]);
const ACTIVE_ALTERNATE_REQUEST_STATUSES = new Set(["requested", "handled"]);
const FOCUS_PERIOD_DAYS = 14;

const state = {
  db: null,
  functions: null,
  slots: [],
  professors: [],
  adminReservations: [],
  alternateRequests: [],
  openCounselRequests: [],
  studentRoster: [],
  selectedReminderStudentNos: new Set(),
  config: {
    semesterLabel: "2026학년도 1학기",
    semesterStartDate: "2026-03-02",
    midtermDate: "2026-04-20",
    finalDate: "2026-06-15",
    firstRoundFocusStartDate: "2026-03-02",
    firstRoundFocusEndDate: "2026-04-19",
    secondRoundFocusStartDate: "2026-04-20",
    secondRoundFocusEndDate: "2026-06-14",
    professors: [],
    supportMessage: "예약 확정 시 문자 알림이 발송됩니다.",
  },
  selectedSlotId: "",
  selectedProfessorId: "",
  phaseFilter: "all",
  reminderPhase: "1",
  reminderPhaseInitialized: false,
  systemAdminCode: sessionStorage.getItem("omtSystemAdminCode") || "",
  adminCode: sessionStorage.getItem("omtAdminCode") || "",
  adminProfessorId: sessionStorage.getItem("omtAdminProfessorId") || "",
};

const els = {};

function dateFromIso(isoString) {
  return new Date(isoString);
}

function kstMidnight(dateString) {
  return new Date(`${dateString}T00:00:00+09:00`);
}

function formatDate(date) {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    timeZone: "Asia/Seoul",
  }).format(date);
}

function formatTime(date) {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Seoul",
  }).format(date);
}

function formatDateTimeRange(startIso, endIso) {
  const start = dateFromIso(startIso);
  const end = dateFromIso(endIso);
  const ymd = new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Seoul",
  }).format(start);
  return `${ymd} ${formatTime(start)}~${formatTime(end)}`;
}

function getPhaseLabel(phase) {
  return `${phase}차 면담`;
}

function normalizePhone(value) {
  return String(value || "").replace(/[^\d]/g, "");
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00+09:00`);
  date.setDate(date.getDate() + days);
  return new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Seoul",
  }).format(date);
}

function getInclusiveDays(startDateString, endDateString) {
  const start = new Date(`${startDateString}T00:00:00+09:00`);
  const end = new Date(`${endDateString}T00:00:00+09:00`);
  const diff = end.getTime() - start.getTime();
  return Math.floor(diff / (24 * 60 * 60 * 1000)) + 1;
}

function setInlineMessage(element, text, isError = false) {
  element.textContent = text;
  element.style.color = isError ? "var(--danger)" : "var(--muted)";
}

function setBookingSuccess(lookupUrl) {
  els.bookingMessage.style.color = "var(--muted)";
  els.bookingMessage.innerHTML = `예약 신청이 접수되었습니다. 예약 확인 주소: <a href="${lookupUrl}">${lookupUrl}</a>`;
}

function maskStudentName(name) {
  const chars = Array.from(name || "");
  if (chars.length <= 1) {
    return `${name || ""}○`;
  }
  if (chars.length === 2) {
    return `${chars[0]}○`;
  }
  return `${chars[0]}○○`;
}

function renderPhoneLink(phone, label = phone) {
  const digits = normalizePhone(phone);
  if (!digits) {
    return label || "-";
  }
  return `<a class="phone-link" href="tel:${digits}">${label || phone}</a>`;
}

function groupSlotsByDay(slots) {
  return slots.reduce((acc, slot) => {
    const key = new Intl.DateTimeFormat("sv-SE", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: "Asia/Seoul",
    }).format(dateFromIso(slot.startAt));
    acc[key] = acc[key] || [];
    acc[key].push(slot);
    return acc;
  }, {});
}

function getActiveProfessors() {
  return state.professors.filter((professor) => professor.active !== false);
}

function getSelectedProfessor() {
  return getActiveProfessors().find((professor) => professor.id === state.selectedProfessorId) || null;
}

function getProfessorBookingLink(professorId) {
  const url = new URL(`${window.location.origin}${window.location.pathname}`);
  if (professorId) {
    url.searchParams.set("professorId", professorId);
  }
  return url.toString();
}

function syncProfessorSelectValues() {
  [els.publicProfessorSelect, els.bookingProfessorId, els.alternateProfessorId, els.openCounselProfessorId].forEach((element) => {
    if (element && state.selectedProfessorId) {
      element.value = state.selectedProfessorId;
    }
  });
}

function getVisibleSlots() {
  return state.slots.filter((slot) => {
    if (!state.selectedProfessorId) {
      return true;
    }
    return slot.professorId === state.selectedProfessorId;
  });
}

function getMissingStudentsForPhase(phase) {
  const appliedStudentNos = new Set(
    state.adminReservations
      .filter((reservation) => String(reservation.phase) === String(phase))
      .filter((reservation) => ACTIVE_RESERVATION_STATUSES.has(reservation.status))
      .map((reservation) => reservation.studentNo),
  );
  state.alternateRequests
    .filter((request) => String(request.phase) === String(phase))
    .filter((request) => ACTIVE_ALTERNATE_REQUEST_STATUSES.has(request.status))
    .forEach((request) => appliedStudentNos.add(request.studentNo));

  return state.studentRoster.filter((student) => !appliedStudentNos.has(student.studentNo));
}

function syncReminderSelection() {
  const missingStudents = getMissingStudentsForPhase(state.reminderPhase);
  const validNos = new Set(missingStudents.map((student) => student.studentNo));
  const nextSelection = new Set();

  if (!state.selectedReminderStudentNos.size) {
    missingStudents.forEach((student) => nextSelection.add(student.studentNo));
  } else {
    state.selectedReminderStudentNos.forEach((studentNo) => {
      if (validNos.has(studentNo)) {
        nextSelection.add(studentNo);
      }
    });
    if (!nextSelection.size) {
      missingStudents.forEach((student) => nextSelection.add(student.studentNo));
    }
  }

  state.selectedReminderStudentNos = nextSelection;
}

function renderProfessorOptions(selectElement, includePlaceholder = false) {
  if (!selectElement) {
    return;
  }

  const options = [];
  if (includePlaceholder) {
    options.push(`<option value="">지도교수를 선택하세요</option>`);
  }

  getActiveProfessors().forEach((professor) => {
    options.push(`<option value="${professor.id}">${professor.name} · ${professor.departmentName}</option>`);
  });
  selectElement.innerHTML = options.join("");
}

function populateProfessorSelects() {
  renderProfessorOptions(els.publicProfessorSelect);
  renderProfessorOptions(els.bookingProfessorId);
  renderProfessorOptions(els.alternateProfessorId);
  renderProfessorOptions(els.openCounselProfessorId);
  renderProfessorOptions(els.adminProfessorSelect, true);

  const firstProfessor = getActiveProfessors()[0];
  const hasSelectedProfessor = getActiveProfessors().some((professor) => professor.id === state.selectedProfessorId);
  if ((!state.selectedProfessorId || !hasSelectedProfessor) && firstProfessor) {
    state.selectedProfessorId = firstProfessor.id;
  }

  syncProfessorSelectValues();

  if (state.adminProfessorId && els.adminProfessorSelect) {
    els.adminProfessorSelect.value = state.adminProfessorId;
  }
}

function buildBroadcastMessage(students) {
  const link = `${window.location.origin}/`;
  const names = students.map((student) => maskStudentName(student.studentName)).join(", ");
  return `[${getPhaseLabel(state.reminderPhase)} 미신청 학생 안내]

아래 학생은 아직 신청이 완료되지 않았습니다.
${names}

아래 링크에서 예약해주세요.
${link}`;
}

function buildPersonalMessage(student) {
  const link = `${window.location.origin}/`;
  return `${student.studentName} 학생,
${getPhaseLabel(state.reminderPhase)} 신청이 아직 완료되지 않았습니다.

아래 링크에서 예약해주세요.
${link}`;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

function renderSummary() {
  const visibleSlots = getVisibleSlots();
  const counts = {
    all: visibleSlots.length,
    open: visibleSlots.filter((slot) => slot.status === "open").length,
    pending: visibleSlots.filter((slot) => slot.status === "pending").length,
    confirmed: visibleSlots.filter((slot) => slot.status === "confirmed").length,
  };

  els.slotSummary.innerHTML = `
    <div class="summary-card"><span>전체 슬롯</span><strong>${counts.all}</strong></div>
    <div class="summary-card"><span>예약 가능</span><strong>${counts.open}</strong></div>
    <div class="summary-card"><span>승인 대기</span><strong>${counts.pending}</strong></div>
    <div class="summary-card"><span>면담 확정</span><strong>${counts.confirmed}</strong></div>
  `;
}

function renderSlots() {
  const filtered = getVisibleSlots().filter((slot) => {
    if (state.phaseFilter === "all") {
      return true;
    }
    return String(slot.phase) === state.phaseFilter;
  });

  const groups = groupSlotsByDay(filtered);
  const keys = Object.keys(groups).sort();

  if (!keys.length) {
    els.slotList.innerHTML = `<div class="lookup-card">등록된 상담 가능 시간이 없습니다.</div>`;
    return;
  }

  els.slotList.innerHTML = keys.map((key) => {
    const dailySlots = groups[key]
      .sort((a, b) => a.startAt.localeCompare(b.startAt))
      .map((slot) => {
        const buttonClass = slot.id === state.selectedSlotId ? "slot-button selected" : `slot-button ${slot.status}`;
        const disabled = slot.status !== "open" ? "disabled" : "";
        return `
          <button class="${buttonClass}" type="button" data-slot-id="${slot.id}" ${disabled}>
            ${formatTime(dateFromIso(slot.startAt))}~${formatTime(dateFromIso(slot.endAt))} · ${STATUS_LABELS[slot.status]}
          </button>
        `;
      })
      .join("");

    const dayDate = dateFromIso(`${key}T00:00:00+09:00`);
    const phase = groups[key][0].phase;
    return `
      <article class="slot-day">
        <div class="slot-day-head">
          <div>
            <h3>${formatDate(dayDate)}</h3>
            <p>${getPhaseLabel(phase)}</p>
          </div>
        </div>
        <div class="slot-tags">${dailySlots}</div>
      </article>
    `;
  }).join("");
}

function updateHero() {
  els.semesterLabel.textContent = state.config.semesterLabel;
  els.semesterPeriod.textContent = [
    `${state.config.semesterStartDate} ~ ${state.config.midtermDate} 이전 1차 / ${state.config.midtermDate} ~ ${state.config.finalDate} 이전 2차`,
    `집중면담 1차: ${state.config.firstRoundFocusStartDate} ~ ${state.config.firstRoundFocusEndDate}`,
    `집중면담 2차: ${state.config.secondRoundFocusStartDate} ~ ${state.config.secondRoundFocusEndDate}`,
  ].join(" · ");
  els.supportMessage.textContent = state.config.supportMessage;
}

function fillConfigForm() {
  els.configSemesterLabel.value = state.config.semesterLabel;
  els.configSemesterStartDate.value = state.config.semesterStartDate;
  els.configMidtermDate.value = state.config.midtermDate;
  els.configFinalDate.value = state.config.finalDate;
  els.configFirstRoundFocusStartDate.value = state.config.firstRoundFocusStartDate;
  els.configFirstRoundFocusEndDate.value = state.config.firstRoundFocusEndDate;
  els.configSecondRoundFocusStartDate.value = state.config.secondRoundFocusStartDate;
  els.configSecondRoundFocusEndDate.value = state.config.secondRoundFocusEndDate;
  els.configSupportMessage.value = state.config.supportMessage;
}

function fillRosterForm() {
  els.rosterInput.value = state.studentRoster
    .map((student) => `${student.studentNo} ${student.studentName}`)
    .join("\n");
}

function fillProfessorDirectoryForm() {
  if (!els.professorDirectoryInput) {
    return;
  }
  els.professorDirectoryInput.value = getActiveProfessors()
    .map((professor) => `${professor.id},${professor.name},${professor.phone},${professor.departmentName},`)
    .join("\n");
}

function renderLookupResults(result) {
  const reservations = result.reservations || [];
  const alternateRequests = result.alternateRequests || [];
  const openCounselRequests = result.openCounselRequests || [];
  if (!reservations.length && !alternateRequests.length && !openCounselRequests.length) {
    els.lookupResults.innerHTML = `<div class="lookup-card">일치하는 예약이 없습니다. 이름, 학번, 휴대폰 뒷자리를 다시 확인해주세요.</div>`;
    return;
  }

  const reservationCards = reservations.map((reservation) => {
    const approvedDetails = reservation.status === "approved"
      ? `
          <p>${reservation.studentName} 학생의 전화면담이 확정되었습니다.</p>
          <p>일시: ${formatDateTimeRange(reservation.startAt, reservation.endAt)}</p>
          <p>지도교수 전화: ${renderPhoneLink(reservation.professorPhone, reservation.professorPhone)}</p>
          <p>상담 회차: ${getPhaseLabel(reservation.phase)}</p>
        `
      : `
          <p>상태: ${reservation.statusLabel}</p>
          <p>상담 회차: ${getPhaseLabel(reservation.phase)}</p>
          <p>신청 시간: ${formatDateTimeRange(reservation.startAt, reservation.endAt)}</p>
        `;

    return `
      <article class="lookup-card">
        <span class="status-pill ${reservation.status}">${reservation.statusLabel}</span>
        ${approvedDetails}
      </article>
    `;
  });

  const alternateCards = alternateRequests.map((request) => `
    <article class="lookup-card">
      <span class="status-pill ${request.status}">${request.statusLabel}</span>
      <p>${request.studentName} 학생의 대체 면담 요청이 접수되었습니다.</p>
      <p>상담 회차: ${getPhaseLabel(request.phase)}</p>
      <p>가능 시간: ${request.preferredTimeText}</p>
      <p>사유: ${request.reason || "미입력"}</p>
      <p>지도교수 전화: ${renderPhoneLink(request.professorPhone, request.professorPhone)}</p>
    </article>
  `);

  const openCounselCards = openCounselRequests.map((request) => `
    <article class="lookup-card">
      <span class="status-pill ${request.status}">${request.statusLabel}</span>
      <p>${request.studentName} 학생의 수시면담 신청이 접수되었습니다.</p>
      <p>상담 주제: ${request.topic}</p>
      <p>가능 시간: ${request.preferredTimeText}</p>
      <p>요청 내용: ${request.reason || "미입력"}</p>
      <p>지도교수 전화: ${renderPhoneLink(request.professorPhone, request.professorPhone)}</p>
    </article>
  `);

  els.lookupResults.innerHTML = [...reservationCards, ...alternateCards, ...openCounselCards].join("");
}

function renderPendingReservations() {
  const pending = state.adminReservations.filter((reservation) => reservation.status === "pending");
  if (!pending.length) {
    els.pendingReservations.innerHTML = `<div class="reservation-card">승인 대기 중인 예약이 없습니다.</div>`;
    return;
  }

  els.pendingReservations.innerHTML = pending.map((reservation) => `
    <article class="reservation-card">
      <span class="status-pill pending">승인대기</span>
      <p><strong>${reservation.studentName}</strong> / ${reservation.studentNo}</p>
      <p>${formatDateTimeRange(reservation.startAt, reservation.endAt)} · ${getPhaseLabel(reservation.phase)}</p>
      <p>학생 연락처: ${renderPhoneLink(reservation.phone, reservation.phone)}</p>
      <p>메모: ${reservation.note || "없음"}</p>
      <div class="reservation-actions">
        <button class="ghost-btn" type="button" data-review-id="${reservation.id}" data-decision="approved">승인</button>
        <button class="danger-btn" type="button" data-review-id="${reservation.id}" data-decision="rejected">반려</button>
      </div>
    </article>
  `).join("");
}

function renderAlternateRequestList() {
  const requests = state.alternateRequests
    .filter((request) => request.status !== "cancelled")
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  if (!requests.length) {
    els.alternateRequestList.innerHTML = `<div class="reservation-card">대체 면담 요청이 없습니다.</div>`;
    return;
  }

  els.alternateRequestList.innerHTML = requests.map((request) => {
    const actionButtons = request.status === "requested"
      ? `
          <div class="reservation-actions">
            <a class="secondary-btn phone-link" href="tel:${normalizePhone(request.phone)}">학생에게 전화걸기</a>
            <button class="ghost-btn" type="button" data-alt-review-id="${request.id}" data-alt-decision="handled">조율 완료</button>
            <button class="danger-btn" type="button" data-alt-review-id="${request.id}" data-alt-decision="cancelled">취소</button>
          </div>
        `
      : `
          <div class="reservation-actions">
            <span class="status-pill handled">조율 완료됨</span>
          </div>
        `;

    return `
      <article class="reservation-card">
        <span class="status-pill ${request.status}">${request.statusLabel}</span>
        <p><strong>${request.studentName}</strong> / ${request.studentNo}</p>
        <p>상담 회차: ${getPhaseLabel(request.phase)}</p>
        <p>학생 연락처: ${renderPhoneLink(request.phone, request.phone)}</p>
        <p>가능 시간: ${request.preferredTimeText}</p>
        <p>사유: ${request.reason || "미입력"}</p>
        ${actionButtons}
      </article>
    `;
  }).join("");
}

function renderOpenCounselRequestList() {
  const requests = state.openCounselRequests
    .filter((request) => request.status !== "cancelled")
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  if (!requests.length) {
    els.openCounselRequestList.innerHTML = `<div class="reservation-card">수시면담 신청이 없습니다.</div>`;
    return;
  }

  els.openCounselRequestList.innerHTML = requests.map((request) => {
    const actionButtons = request.status === "requested"
      ? `
          <div class="reservation-actions">
            <a class="secondary-btn phone-link" href="tel:${normalizePhone(request.phone)}">학생에게 전화걸기</a>
            <button class="ghost-btn" type="button" data-open-review-id="${request.id}" data-open-decision="handled">조율 완료</button>
            <button class="danger-btn" type="button" data-open-review-id="${request.id}" data-open-decision="cancelled">취소</button>
          </div>
        `
      : `
          <div class="reservation-actions">
            <span class="status-pill handled">조율 완료됨</span>
          </div>
        `;

    return `
      <article class="reservation-card">
        <span class="status-pill ${request.status}">${request.statusLabel}</span>
        <p><strong>${request.studentName}</strong> / ${request.studentNo}</p>
        <p>학생 연락처: ${renderPhoneLink(request.phone, request.phone)}</p>
        <p>상담 주제: ${request.topic}</p>
        <p>가능 시간: ${request.preferredTimeText}</p>
        <p>요청 내용: ${request.reason || "미입력"}</p>
        ${actionButtons}
      </article>
    `;
  }).join("");
}

function renderCalendar() {
  const monthValue = els.calendarMonth.value;
  if (!monthValue) {
    return;
  }

  const [year, month] = monthValue.split("-").map(Number);
  const startWeekday = new Date(`${monthValue}-01T00:00:00+09:00`).getDay();
  const lastDate = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const confirmed = state.adminReservations.filter((reservation) => {
    if (reservation.status !== "approved") {
      return false;
    }
    const date = dateFromIso(reservation.startAt);
    const y = Number(new Intl.DateTimeFormat("sv-SE", {year: "numeric", timeZone: "Asia/Seoul"}).format(date));
    const m = Number(new Intl.DateTimeFormat("sv-SE", {month: "2-digit", timeZone: "Asia/Seoul"}).format(date));
    return y === year && m === month;
  });

  const byDate = confirmed.reduce((acc, reservation) => {
    const key = new Intl.DateTimeFormat("sv-SE", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: "Asia/Seoul",
    }).format(dateFromIso(reservation.startAt));
    acc[key] = acc[key] || [];
    acc[key].push(reservation);
    return acc;
  }, {});

  const cells = [];
  for (let i = 0; i < startWeekday; i += 1) {
    cells.push(`<div class="calendar-cell is-empty"></div>`);
  }

  for (let day = 1; day <= lastDate; day += 1) {
    const dateKey = `${monthValue}-${String(day).padStart(2, "0")}`;
    const items = (byDate[dateKey] || []).map((reservation) => `
      <span>${formatTime(dateFromIso(reservation.startAt))} ${reservation.studentName}</span>
    `).join("");
    cells.push(`
      <div class="calendar-cell">
        <strong>${day}</strong>
        <div class="calendar-day-list">${items || "<span>확정 일정 없음</span>"}</div>
      </div>
    `);
  }

  els.calendarGrid.innerHTML = cells.join("");
}

function renderCallManagementList() {
  const reservations = state.adminReservations
    .filter((reservation) => ["approved", "no_answer"].includes(reservation.status))
    .sort((a, b) => a.startAt.localeCompare(b.startAt));

  if (!reservations.length) {
    els.callManagementList.innerHTML = `<div class="reservation-card">전화 통화 관리 대상 일정이 없습니다.</div>`;
    return;
  }

  els.callManagementList.innerHTML = reservations.map((reservation) => {
    const actions = reservation.status === "approved"
      ? `
          <div class="reservation-actions">
            <a class="secondary-btn phone-link" href="tel:${normalizePhone(reservation.phone)}">학생에게 전화걸기</a>
            <button class="danger-btn" type="button" data-call-no-answer="${reservation.id}">통화불가 처리</button>
          </div>
        `
      : `
          <div class="reservation-actions">
            <span class="status-pill no_answer">미신청으로 재분류됨</span>
          </div>
        `;

    return `
      <article class="reservation-card">
        <span class="status-pill ${reservation.status}">${reservation.statusLabel}</span>
        <p><strong>${reservation.studentName}</strong> / ${reservation.studentNo}</p>
        <p>${formatDateTimeRange(reservation.startAt, reservation.endAt)} · ${getPhaseLabel(reservation.phase)}</p>
        <p>학생 연락처: ${renderPhoneLink(reservation.phone, reservation.phone)}</p>
        ${actions}
      </article>
    `;
  }).join("");
}

function renderReminderPanel() {
  const missingStudents = getMissingStudentsForPhase(state.reminderPhase);
  syncReminderSelection();

  els.missingCountLabel.textContent = `미신청 학생 ${missingStudents.length}명`;
  els.missingPhaseLabel.textContent = getPhaseLabel(state.reminderPhase);

  if (!state.studentRoster.length) {
    els.missingStudentList.innerHTML = `<div class="reservation-card">먼저 학생 명단을 저장해주세요.</div>`;
    return;
  }

  if (!missingStudents.length) {
    els.missingStudentList.innerHTML = `<div class="reservation-card">${getPhaseLabel(state.reminderPhase)} 미신청 학생이 없습니다.</div>`;
    return;
  }

  els.missingStudentList.innerHTML = missingStudents.map((student) => `
    <div class="student-row">
      <label>
        <input
          type="checkbox"
          data-reminder-student-no="${student.studentNo}"
          ${state.selectedReminderStudentNos.has(student.studentNo) ? "checked" : ""}
        >
        <span class="student-meta">
          <strong>${maskStudentName(student.studentName)}</strong>
          <small>${student.studentNo}</small>
        </span>
      </label>
      <button class="ghost-btn" type="button" data-copy-personal="${student.studentNo}">개인 메시지 복사</button>
    </div>
  `).join("");
}

function selectSlot(slotId) {
  state.selectedSlotId = slotId;
  const slot = state.slots.find((item) => item.id === slotId);
  if (!slot) {
    els.selectedSlotLabel.textContent = "상담 시간을 선택하세요.";
    return;
  }
  els.selectedSlotId.value = slotId;
  els.selectedSlotLabel.textContent = `${formatDateTimeRange(slot.startAt, slot.endAt)} · ${getPhaseLabel(slot.phase)}`;
  renderSlots();
}

function parseRosterInput(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    throw new Error("저장할 학생 명단이 없습니다.");
  }

  return lines.map((line, index) => {
    const parts = line.split(/[\t,]+|\s{2,}|\s/).filter(Boolean);
    if (parts.length < 2) {
      throw new Error(`${index + 1}번째 줄 형식이 올바르지 않습니다. "학번 이름" 형식으로 입력해주세요.`);
    }
    const [studentNo, ...nameParts] = parts;
    if (!/^\d+$/.test(studentNo)) {
      throw new Error(`${index + 1}번째 줄 학번 형식이 올바르지 않습니다.`);
    }
    return {
      studentNo,
      studentName: nameParts.join(" ").trim(),
    };
  });
}

async function loadPublicData() {
  const [configDoc, slotsSnapshot] = await Promise.all([
    state.db.collection("publicConfig").doc("general").get(),
    state.db.collection("availabilitySlots").orderBy("startAt", "asc").get(),
  ]);

  if (configDoc.exists) {
    state.config = {...state.config, ...configDoc.data()};
  }
  state.professors = Array.isArray(state.config.professors) ? state.config.professors : [];

  state.slots = slotsSnapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      ...data,
      startAt: data.startAt.toDate().toISOString(),
      endAt: data.endAt.toDate().toISOString(),
    };
  });

  populateProfessorSelects();
  updateHero();
  renderSummary();
  renderSlots();
}

function inferReminderPhase() {
  const today = new Date();
  const firstFocusStart = kstMidnight(state.config.firstRoundFocusStartDate);
  const firstFocusEnd = new Date(`${state.config.firstRoundFocusEndDate}T23:59:59+09:00`);
  const secondFocusStart = kstMidnight(state.config.secondRoundFocusStartDate);
  const secondFocusEnd = new Date(`${state.config.secondRoundFocusEndDate}T23:59:59+09:00`);
  const midterm = kstMidnight(state.config.midtermDate);
  const finalDate = kstMidnight(state.config.finalDate);
  if (today >= firstFocusStart && today <= firstFocusEnd) {
    return "1";
  }
  if (today >= secondFocusStart && today <= secondFocusEnd) {
    return "2";
  }
  if (today >= midterm && today < finalDate) {
    return "2";
  }
  return "1";
}

async function loadSystemDashboard() {
  const getSystemDashboard = state.functions.httpsCallable("getSystemDashboard");
  const response = await getSystemDashboard({adminCode: state.systemAdminCode});
  state.config = {...state.config, ...response.data.config};
  state.studentRoster = response.data.studentRoster || [];
  state.professors = response.data.professors || [];
  populateProfessorSelects();
  updateHero();
  fillConfigForm();
  fillProfessorDirectoryForm();
  fillRosterForm();
}

async function loadAdminDashboard() {
  const getProfessorDashboard = state.functions.httpsCallable("getProfessorDashboard");
  const response = await getProfessorDashboard({
    adminCode: state.adminCode,
    professorId: state.adminProfessorId,
  });
  state.config = {...state.config, ...response.data.config};
  state.professors = Array.isArray(state.config.professors) ? state.config.professors : [];
  state.selectedProfessorId = state.adminProfessorId;
  state.adminReservations = response.data.reservations;
  state.alternateRequests = response.data.alternateRequests || [];
  state.openCounselRequests = response.data.openCounselRequests || [];
  state.studentRoster = response.data.studentRoster || [];
  state.slots = response.data.slots || [];
  if (!state.reminderPhaseInitialized) {
    state.reminderPhase = inferReminderPhase();
    state.reminderPhaseInitialized = true;
  }
  populateProfessorSelects();
  updateHero();
  renderSummary();
  renderSlots();
  renderPendingReservations();
  renderAlternateRequestList();
  renderOpenCounselRequestList();
  renderReminderPanel();
  renderCalendar();
  renderCallManagementList();
  document.querySelectorAll("[data-reminder-phase]").forEach((button) => {
    button.classList.toggle("active", button.dataset.reminderPhase === state.reminderPhase);
  });
}

async function unlockAdminPanel() {
  if (!state.adminProfessorId) {
    throw new Error("지도교수를 선택해주세요.");
  }
  els.adminPanel.classList.remove("hidden");
  sessionStorage.setItem("omtAdminCode", state.adminCode);
  sessionStorage.setItem("omtAdminProfessorId", state.adminProfessorId);
  setInlineMessage(els.adminAuthMessage, "관리자 인증이 완료되었습니다.");
  await loadAdminDashboard();
  els.adminPanel.scrollIntoView({behavior: "smooth", block: "start"});
}

async function unlockSystemPanel() {
  const bootstrapConfig = state.functions.httpsCallable("bootstrapConfig");
  await bootstrapConfig({adminCode: state.systemAdminCode});
  els.systemPanel.classList.remove("hidden");
  sessionStorage.setItem("omtSystemAdminCode", state.systemAdminCode);
  setInlineMessage(els.systemAuthMessage, "시스템 관리자 인증이 완료되었습니다.");
  await loadSystemDashboard();
  els.systemPanel.scrollIntoView({behavior: "smooth", block: "start"});
}

function getSelectedReminderStudents() {
  const missing = getMissingStudentsForPhase(state.reminderPhase);
  const selected = missing.filter((student) => state.selectedReminderStudentNos.has(student.studentNo));
  if (!selected.length) {
    throw new Error("메시지를 복사할 학생을 하나 이상 선택해주세요.");
  }
  return selected;
}

function bindEvents() {
  document.addEventListener("click", async (event) => {
    const slotButton = event.target.closest("[data-slot-id]");
    if (slotButton) {
      selectSlot(slotButton.dataset.slotId);
      return;
    }

    const phaseButton = event.target.closest("[data-phase-filter]");
    if (phaseButton) {
      state.phaseFilter = phaseButton.dataset.phaseFilter;
      document.querySelectorAll("[data-phase-filter]").forEach((button) => {
        button.classList.toggle("active", button === phaseButton);
      });
      renderSlots();
      return;
    }

    const reminderPhaseButton = event.target.closest("[data-reminder-phase]");
    if (reminderPhaseButton) {
      state.reminderPhase = reminderPhaseButton.dataset.reminderPhase;
      state.selectedReminderStudentNos = new Set();
      document.querySelectorAll("[data-reminder-phase]").forEach((button) => {
        button.classList.toggle("active", button === reminderPhaseButton);
      });
      renderReminderPanel();
      return;
    }

    const reviewButton = event.target.closest("[data-review-id]");
    if (reviewButton) {
      const reviewReservation = state.functions.httpsCallable("reviewReservation");
      reviewButton.disabled = true;
      try {
        await reviewReservation({
          adminCode: state.adminCode,
          professorId: state.adminProfessorId,
          reservationId: reviewButton.dataset.reviewId,
          decision: reviewButton.dataset.decision,
        });
        await loadAdminDashboard();
      } catch (error) {
        alert(error.message);
      } finally {
        reviewButton.disabled = false;
      }
      return;
    }

    const noAnswerButton = event.target.closest("[data-call-no-answer]");
    if (noAnswerButton) {
      const reviewReservation = state.functions.httpsCallable("reviewReservation");
      noAnswerButton.disabled = true;
      try {
        await reviewReservation({
          adminCode: state.adminCode,
          professorId: state.adminProfessorId,
          reservationId: noAnswerButton.dataset.callNoAnswer,
          decision: "no_answer",
        });
        await loadAdminDashboard();
        setInlineMessage(els.reminderMessage, "통화불가로 처리했고 해당 학생은 미신청 목록에 다시 포함됩니다.");
      } catch (error) {
        setInlineMessage(els.reminderMessage, error.message, true);
      } finally {
        noAnswerButton.disabled = false;
      }
      return;
    }

    const altReviewButton = event.target.closest("[data-alt-review-id]");
    if (altReviewButton) {
      const reviewAlternateRequest = state.functions.httpsCallable("reviewAlternateRequest");
      altReviewButton.disabled = true;
      try {
        await reviewAlternateRequest({
          adminCode: state.adminCode,
          professorId: state.adminProfessorId,
          requestId: altReviewButton.dataset.altReviewId,
          decision: altReviewButton.dataset.altDecision,
        });
        await loadAdminDashboard();
      } catch (error) {
        setInlineMessage(els.reminderMessage, error.message, true);
      } finally {
        altReviewButton.disabled = false;
      }
      return;
    }

    const openReviewButton = event.target.closest("[data-open-review-id]");
    if (openReviewButton) {
      const reviewOpenCounselRequest = state.functions.httpsCallable("reviewOpenCounselRequest");
      openReviewButton.disabled = true;
      try {
        await reviewOpenCounselRequest({
          adminCode: state.adminCode,
          professorId: state.adminProfessorId,
          requestId: openReviewButton.dataset.openReviewId,
          decision: openReviewButton.dataset.openDecision,
        });
        await loadAdminDashboard();
      } catch (error) {
        setInlineMessage(els.reminderMessage, error.message, true);
      } finally {
        openReviewButton.disabled = false;
      }
      return;
    }

    const personalCopyButton = event.target.closest("[data-copy-personal]");
    if (personalCopyButton) {
      const student = getMissingStudentsForPhase(state.reminderPhase)
        .find((item) => item.studentNo === personalCopyButton.dataset.copyPersonal);
      if (!student) {
        return;
      }
      try {
        await copyText(buildPersonalMessage(student));
        setInlineMessage(els.reminderMessage, `${student.studentName} 학생용 메시지를 복사했습니다.`);
      } catch (error) {
        setInlineMessage(els.reminderMessage, "클립보드 복사에 실패했습니다.", true);
      }
    }
  });

  document.addEventListener("change", (event) => {
    const checkbox = event.target.closest("[data-reminder-student-no]");
    if (!checkbox) {
      return;
    }
    const studentNo = checkbox.dataset.reminderStudentNo;
    if (checkbox.checked) {
      state.selectedReminderStudentNos.add(studentNo);
    } else {
      state.selectedReminderStudentNos.delete(studentNo);
    }
  });

  els.studentPhone.addEventListener("input", () => {
    const normalized = normalizePhone(els.studentPhone.value);
    els.studentPhoneLast4.value = normalized.slice(-4);
  });

  els.publicProfessorSelect.addEventListener("change", () => {
    state.selectedProfessorId = els.publicProfessorSelect.value;
    syncProfessorSelectValues();
    state.selectedSlotId = "";
    els.selectedSlotId.value = "";
    els.selectedSlotLabel.textContent = "상담 시간을 선택하세요.";
    renderSummary();
    renderSlots();
  });

  els.configFirstRoundFocusStartDate.addEventListener("change", () => {
    if (!els.configFirstRoundFocusStartDate.value) {
      return;
    }
    const suggestedEnd = addDays(els.configFirstRoundFocusStartDate.value, FOCUS_PERIOD_DAYS - 1);
    if (!els.configFirstRoundFocusEndDate.value || els.configFirstRoundFocusEndDate.value < els.configFirstRoundFocusStartDate.value) {
      els.configFirstRoundFocusEndDate.value = suggestedEnd;
    }
  });

  els.configSecondRoundFocusStartDate.addEventListener("change", () => {
    if (!els.configSecondRoundFocusStartDate.value) {
      return;
    }
    const suggestedEnd = addDays(els.configSecondRoundFocusStartDate.value, FOCUS_PERIOD_DAYS - 1);
    if (!els.configSecondRoundFocusEndDate.value || els.configSecondRoundFocusEndDate.value < els.configSecondRoundFocusStartDate.value) {
      els.configSecondRoundFocusEndDate.value = suggestedEnd;
    }
  });

  els.bookingForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.selectedSlotId) {
      setInlineMessage(els.bookingMessage, "먼저 상담 시간을 선택해주세요.", true);
      return;
    }

    const createReservation = state.functions.httpsCallable("createReservation");
    try {
      const response = await createReservation({
        slotId: state.selectedSlotId,
        professorId: els.bookingProfessorId.value,
        studentName: els.studentName.value.trim(),
        studentNo: els.studentNo.value.trim(),
        phone: els.studentPhone.value.trim(),
        note: els.studentNote.value.trim(),
        lookupBaseUrl: `${window.location.origin}${window.location.pathname}`,
      });
      const {lookupUrl} = response.data;
      setBookingSuccess(lookupUrl);
      els.lookupStudentNo.value = els.studentNo.value.trim();
      els.lookupName.value = els.studentName.value.trim();
      els.lookupPhoneLast4.value = els.studentPhoneLast4.value.trim();
      state.selectedSlotId = "";
      els.selectedSlotId.value = "";
      els.selectedSlotLabel.textContent = "상담 시간을 선택하세요.";
      els.bookingForm.reset();
      syncProfessorSelectValues();
      await loadPublicData();
      if (!els.adminPanel.classList.contains("hidden")) {
        await loadAdminDashboard();
      }
    } catch (error) {
      setInlineMessage(els.bookingMessage, error.message, true);
    }
  });

  els.lookupForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const lookupReservations = state.functions.httpsCallable("lookupReservations");
    try {
      const response = await lookupReservations({
        studentName: els.lookupName.value.trim(),
        studentNo: els.lookupStudentNo.value.trim(),
        phoneLast4: els.lookupPhoneLast4.value.trim(),
      });
      renderLookupResults(response.data);
    } catch (error) {
      els.lookupResults.innerHTML = `<div class="lookup-card">${error.message}</div>`;
    }
  });

  els.alternateRequestForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const createAlternateRequest = state.functions.httpsCallable("createAlternateRequest");
    try {
      await createAlternateRequest({
        professorId: els.alternateProfessorId.value,
        studentName: els.alternateStudentName.value.trim(),
        studentNo: els.alternateStudentNo.value.trim(),
        phone: els.alternateStudentPhone.value.trim(),
        phase: Number(els.alternatePhase.value),
        preferredTimeText: els.alternatePreferredTimeText.value.trim(),
        reason: els.alternateReason.value.trim(),
      });
      setInlineMessage(els.alternateRequestMessage, "대체 면담 요청이 접수되었습니다. 교수 확인 후 별도 연락이 진행됩니다.");
      els.lookupName.value = els.alternateStudentName.value.trim();
      els.lookupStudentNo.value = els.alternateStudentNo.value.trim();
      els.lookupPhoneLast4.value = normalizePhone(els.alternateStudentPhone.value).slice(-4);
      els.alternateRequestForm.reset();
      syncProfessorSelectValues();
      els.alternatePhase.value = inferReminderPhase();
      if (!els.adminPanel.classList.contains("hidden")) {
        await loadAdminDashboard();
      }
    } catch (error) {
      setInlineMessage(els.alternateRequestMessage, error.message, true);
    }
  });

  els.openCounselRequestForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const createOpenCounselRequest = state.functions.httpsCallable("createOpenCounselRequest");
    try {
      await createOpenCounselRequest({
        professorId: els.openCounselProfessorId.value,
        studentName: els.openCounselStudentName.value.trim(),
        studentNo: els.openCounselStudentNo.value.trim(),
        phone: els.openCounselStudentPhone.value.trim(),
        topic: els.openCounselTopic.value.trim(),
        preferredTimeText: els.openCounselPreferredTimeText.value.trim(),
        reason: els.openCounselReason.value.trim(),
      });
      setInlineMessage(els.openCounselRequestMessage, "수시면담 신청이 접수되었습니다. 교수 확인 후 별도 연락이 진행됩니다.");
      els.lookupName.value = els.openCounselStudentName.value.trim();
      els.lookupStudentNo.value = els.openCounselStudentNo.value.trim();
      els.lookupPhoneLast4.value = normalizePhone(els.openCounselStudentPhone.value).slice(-4);
      els.openCounselRequestForm.reset();
      syncProfessorSelectValues();
      if (!els.adminPanel.classList.contains("hidden")) {
        await loadAdminDashboard();
      }
    } catch (error) {
      setInlineMessage(els.openCounselRequestMessage, error.message, true);
    }
  });

  els.adminLoginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    state.adminProfessorId = els.adminProfessorSelect.value;
    state.adminCode = els.adminCode.value.trim();
    try {
      await unlockAdminPanel();
    } catch (error) {
      setInlineMessage(els.adminAuthMessage, error.message, true);
    }
  });

  els.systemLoginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    state.systemAdminCode = els.systemAdminCode.value.trim();
    try {
      await unlockSystemPanel();
    } catch (error) {
      setInlineMessage(els.systemAuthMessage, error.message, true);
    }
  });

  els.configForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const updatePublicConfig = state.functions.httpsCallable("updatePublicConfig");
    const firstFocusDays = getInclusiveDays(
      els.configFirstRoundFocusStartDate.value,
      els.configFirstRoundFocusEndDate.value,
    );
    const secondFocusDays = getInclusiveDays(
      els.configSecondRoundFocusStartDate.value,
      els.configSecondRoundFocusEndDate.value,
    );
    if (firstFocusDays > FOCUS_PERIOD_DAYS) {
      alert(`1차 집중면담기간은 ${FOCUS_PERIOD_DAYS}일 이내로 설정해주세요.`);
      return;
    }
    if (secondFocusDays > FOCUS_PERIOD_DAYS) {
      alert(`2차 집중면담기간은 ${FOCUS_PERIOD_DAYS}일 이내로 설정해주세요.`);
      return;
    }
    try {
      await updatePublicConfig({
        adminCode: state.systemAdminCode,
        semesterLabel: els.configSemesterLabel.value.trim(),
        semesterStartDate: els.configSemesterStartDate.value,
        midtermDate: els.configMidtermDate.value,
        finalDate: els.configFinalDate.value,
        firstRoundFocusStartDate: els.configFirstRoundFocusStartDate.value,
        firstRoundFocusEndDate: els.configFirstRoundFocusEndDate.value,
        secondRoundFocusStartDate: els.configSecondRoundFocusStartDate.value,
        secondRoundFocusEndDate: els.configSecondRoundFocusEndDate.value,
        supportMessage: els.configSupportMessage.value.trim(),
      });
      await loadSystemDashboard();
      await loadPublicData();
    } catch (error) {
      alert(error.message);
    }
  });

  els.availabilityForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const upsertAvailability = state.functions.httpsCallable("upsertAvailability");
    try {
      const response = await upsertAvailability({
        adminCode: state.adminCode,
        professorId: state.adminProfessorId,
        entries: [
          {
            date: els.availabilityDate.value,
            startTime: els.availabilityStartTime.value,
            endTime: els.availabilityEndTime.value,
          },
        ],
      });
      setInlineMessage(els.availabilityMessage, `${response.data.slotCount}개의 10분 슬롯이 반영되었습니다.`);
      await loadAdminDashboard();
    } catch (error) {
      setInlineMessage(els.availabilityMessage, error.message, true);
    }
  });

  els.rosterForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const entries = parseRosterInput(els.rosterInput.value);
      const updateStudentRoster = state.functions.httpsCallable("updateStudentRoster");
      const response = await updateStudentRoster({
        adminCode: state.systemAdminCode,
        entries,
      });
      setInlineMessage(els.rosterMessage, `${response.data.count}명의 학생 명단을 저장했습니다.`);
      await loadSystemDashboard();
    } catch (error) {
      setInlineMessage(els.rosterMessage, error.message, true);
    }
  });

  els.professorDirectoryForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const entries = els.professorDirectoryInput.value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line, index) => {
          const parts = line.split(",").map((part) => part.trim());
          if (parts.length < 5) {
            throw new Error(`${index + 1}번째 줄 형식이 올바르지 않습니다.`);
          }
          return {
            id: parts[0],
            name: parts[1],
            phone: parts[2],
            departmentName: parts[3],
            adminCode: parts[4],
            active: true,
          };
        });
      const updateProfessorDirectory = state.functions.httpsCallable("updateProfessorDirectory");
      const response = await updateProfessorDirectory({
        adminCode: state.systemAdminCode,
        entries,
      });
      setInlineMessage(els.professorDirectoryMessage, `${response.data.count}명의 지도교수 정보를 저장했습니다.`);
      await loadSystemDashboard();
      await loadPublicData();
    } catch (error) {
      setInlineMessage(els.professorDirectoryMessage, error.message, true);
    }
  });

  els.copyBroadcastBtn.addEventListener("click", async () => {
    try {
      const students = getSelectedReminderStudents();
      await copyText(buildBroadcastMessage(students));
      setInlineMessage(els.reminderMessage, "전체 독려 메시지를 복사했습니다.");
    } catch (error) {
      setInlineMessage(els.reminderMessage, error.message, true);
    }
  });

  els.copySelectedBtn.addEventListener("click", async () => {
    try {
      const students = getSelectedReminderStudents();
      const text = students.map((student) => buildPersonalMessage(student)).join("\n\n");
      await copyText(text);
      setInlineMessage(els.reminderMessage, "개인별 메시지를 복사했습니다.");
    } catch (error) {
      setInlineMessage(els.reminderMessage, error.message, true);
    }
  });

  els.calendarMonth.addEventListener("change", renderCalendar);
}

function cacheElements() {
  Object.assign(els, {
    semesterLabel: document.getElementById("semesterLabel"),
    semesterPeriod: document.getElementById("semesterPeriod"),
    supportMessage: document.getElementById("supportMessage"),
    slotSummary: document.getElementById("slotSummary"),
    slotList: document.getElementById("slotList"),
    publicProfessorSelect: document.getElementById("publicProfessorSelect"),
    bookingForm: document.getElementById("bookingForm"),
    selectedSlotId: document.getElementById("selectedSlotId"),
    selectedSlotLabel: document.getElementById("selectedSlotLabel"),
    studentName: document.getElementById("studentName"),
    studentNo: document.getElementById("studentNo"),
    bookingProfessorId: document.getElementById("bookingProfessorId"),
    studentPhone: document.getElementById("studentPhone"),
    studentPhoneLast4: document.getElementById("studentPhoneLast4"),
    studentNote: document.getElementById("studentNote"),
    bookingMessage: document.getElementById("bookingMessage"),
    alternateRequestForm: document.getElementById("alternateRequestForm"),
    alternateStudentName: document.getElementById("alternateStudentName"),
    alternateStudentNo: document.getElementById("alternateStudentNo"),
    alternateStudentPhone: document.getElementById("alternateStudentPhone"),
    alternateProfessorId: document.getElementById("alternateProfessorId"),
    alternatePhase: document.getElementById("alternatePhase"),
    alternatePreferredTimeText: document.getElementById("alternatePreferredTimeText"),
    alternateReason: document.getElementById("alternateReason"),
    alternateRequestMessage: document.getElementById("alternateRequestMessage"),
    openCounselRequestForm: document.getElementById("openCounselRequestForm"),
    openCounselStudentName: document.getElementById("openCounselStudentName"),
    openCounselStudentNo: document.getElementById("openCounselStudentNo"),
    openCounselStudentPhone: document.getElementById("openCounselStudentPhone"),
    openCounselProfessorId: document.getElementById("openCounselProfessorId"),
    openCounselTopic: document.getElementById("openCounselTopic"),
    openCounselPreferredTimeText: document.getElementById("openCounselPreferredTimeText"),
    openCounselReason: document.getElementById("openCounselReason"),
    openCounselRequestMessage: document.getElementById("openCounselRequestMessage"),
    lookupForm: document.getElementById("lookupForm"),
    lookupName: document.getElementById("lookupName"),
    lookupStudentNo: document.getElementById("lookupStudentNo"),
    lookupPhoneLast4: document.getElementById("lookupPhoneLast4"),
    lookupResults: document.getElementById("lookupResults"),
    systemLoginForm: document.getElementById("systemLoginForm"),
    systemAdminCode: document.getElementById("systemAdminCode"),
    systemAuthMessage: document.getElementById("systemAuthMessage"),
    systemPanel: document.getElementById("systemPanel"),
    adminLoginForm: document.getElementById("adminLoginForm"),
    adminProfessorSelect: document.getElementById("adminProfessorSelect"),
    adminCode: document.getElementById("adminCode"),
    adminAuthMessage: document.getElementById("adminAuthMessage"),
    adminPanel: document.getElementById("adminPanel"),
    configForm: document.getElementById("configForm"),
    configSemesterLabel: document.getElementById("configSemesterLabel"),
    configSemesterStartDate: document.getElementById("configSemesterStartDate"),
    configMidtermDate: document.getElementById("configMidtermDate"),
    configFinalDate: document.getElementById("configFinalDate"),
    configFirstRoundFocusStartDate: document.getElementById("configFirstRoundFocusStartDate"),
    configFirstRoundFocusEndDate: document.getElementById("configFirstRoundFocusEndDate"),
    configSecondRoundFocusStartDate: document.getElementById("configSecondRoundFocusStartDate"),
    configSecondRoundFocusEndDate: document.getElementById("configSecondRoundFocusEndDate"),
    configSupportMessage: document.getElementById("configSupportMessage"),
    professorDirectoryForm: document.getElementById("professorDirectoryForm"),
    professorDirectoryInput: document.getElementById("professorDirectoryInput"),
    professorDirectoryMessage: document.getElementById("professorDirectoryMessage"),
    availabilityForm: document.getElementById("availabilityForm"),
    availabilityDate: document.getElementById("availabilityDate"),
    availabilityStartTime: document.getElementById("availabilityStartTime"),
    availabilityEndTime: document.getElementById("availabilityEndTime"),
    availabilityMessage: document.getElementById("availabilityMessage"),
    rosterForm: document.getElementById("rosterForm"),
    rosterInput: document.getElementById("rosterInput"),
    rosterMessage: document.getElementById("rosterMessage"),
    missingCountLabel: document.getElementById("missingCountLabel"),
    missingPhaseLabel: document.getElementById("missingPhaseLabel"),
    missingStudentList: document.getElementById("missingStudentList"),
    reminderMessage: document.getElementById("reminderMessage"),
    copyBroadcastBtn: document.getElementById("copyBroadcastBtn"),
    copySelectedBtn: document.getElementById("copySelectedBtn"),
    pendingReservations: document.getElementById("pendingReservations"),
    alternateRequestList: document.getElementById("alternateRequestList"),
    openCounselRequestList: document.getElementById("openCounselRequestList"),
    calendarMonth: document.getElementById("calendarMonth"),
    calendarGrid: document.getElementById("calendarGrid"),
    callManagementList: document.getElementById("callManagementList"),
  });
}

function renderProfessorOptions(selectElement, includePlaceholder = false) {
  if (!selectElement) {
    return;
  }

  const options = [];
  if (includePlaceholder) {
    options.push('<option value="">지도교수를 선택해 주세요.</option>');
  }

  getActiveProfessors().forEach((professor) => {
    const departmentName = professor.departmentName ? ` · ${professor.departmentName}` : "";
    options.push(`<option value="${professor.id}">${professor.name}${departmentName}</option>`);
  });
  selectElement.innerHTML = options.join("");
}

function buildBroadcastMessage(students) {
  const professor = getSelectedProfessor();
  const link = getProfessorBookingLink(professor?.id || state.adminProfessorId);
  const names = students.map((student) => maskStudentName(student.studentName)).join(", ");
  const professorLine = professor ? `${professor.name} 지도교수 담당 학생 안내` : "전화면담 신청 안내";
  return `[${getPhaseLabel(state.reminderPhase)} 미신청 학생 안내]

${professorLine}
아래 학생의 전화면담 신청이 아직 완료되지 않았습니다.
${names}

아래 링크에서 예약해 주세요.
${link}`;
}

function buildPersonalMessage(student) {
  const professor = getSelectedProfessor();
  const link = getProfessorBookingLink(professor?.id || state.adminProfessorId);
  const professorName = professor?.name || "지도교수";
  return `${student.studentName} 학생,
${professorName} 교수님 ${getPhaseLabel(state.reminderPhase)} 전화면담 신청이 아직 완료되지 않았습니다.

아래 링크에서 예약해 주세요.
${link}`;
}

function parseRosterInput(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    throw new Error("등록할 학생 명단이 없습니다.");
  }

  const professorIds = new Set(getActiveProfessors().map((professor) => professor.id));
  const hasMultipleProfessors = professorIds.size > 1;
  const defaultProfessorId = getActiveProfessors()[0]?.id || "";

  return lines.map((line, index) => {
    const parts = line.split(/[\t,]+|\s{2,}|\s/).filter(Boolean);
    if (parts.length < 2) {
      throw new Error(`${index + 1}번째 줄 형식이 올바르지 않습니다. "학번 이름 교수ID" 또는 "학번,이름,교수ID" 형식으로 입력해 주세요.`);
    }

    const studentNo = parts[0];
    if (!/^\d+$/.test(studentNo)) {
      throw new Error(`${index + 1}번째 줄 학번 형식이 올바르지 않습니다.`);
    }

    let professorId = "";
    let nameParts = parts.slice(1);
    const lastPart = parts[parts.length - 1];
    if (parts.length >= 3 && professorIds.has(lastPart)) {
      professorId = lastPart;
      nameParts = parts.slice(1, -1);
    }

    if (!professorId && !hasMultipleProfessors) {
      professorId = defaultProfessorId;
    }
    if (hasMultipleProfessors && !professorId) {
      throw new Error(`${index + 1}번째 줄에 지도교수 ID가 없습니다. 다수 지도교수 사용 시 학생별 교수 ID를 함께 입력해 주세요.`);
    }

    const studentName = nameParts.join(" ").trim();
    if (!studentName) {
      throw new Error(`${index + 1}번째 줄 학생 이름이 비어 있습니다.`);
    }

    return {
      studentNo,
      studentName,
      professorId,
    };
  });
}

function fillProfessorDirectoryForm() {
  if (!els.professorDirectoryInput) {
    return;
  }
  els.professorDirectoryInput.value = getActiveProfessors()
    .map((professor) => `${professor.id},${professor.name},${professor.phone},${professor.departmentName},`)
    .join("\n");
  if (els.professorDirectoryMessage && !els.professorDirectoryMessage.textContent) {
    setInlineMessage(els.professorDirectoryMessage, "기존 교수는 코드 칸을 비워 두면 현재 로그인 코드를 유지합니다.");
  }
}

function fillRosterForm() {
  if (!els.rosterInput) {
    return;
  }
  els.rosterInput.value = state.studentRoster
    .map((student) => {
      if (student.professorId) {
        return `${student.studentNo},${student.studentName},${student.professorId}`;
      }
      return `${student.studentNo},${student.studentName}`;
    })
    .join("\n");
}

function getApiBaseUrl() {
  const configured = window.__APP_CONFIG__ && typeof window.__APP_CONFIG__.apiBaseUrl === "string"
    ? window.__APP_CONFIG__.apiBaseUrl.trim()
    : "";
  return configured || window.location.origin;
}

async function apiFetch(path, options = {}) {
  const url = new URL(path, `${getApiBaseUrl().replace(/\/$/, "")}/`);
  const response = await fetch(url.toString(), {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || "서버 요청 처리에 실패했습니다.";
    throw new Error(message);
  }
  return payload;
}

function toTimestampLike(isoString) {
  return {
    toDate() {
      return new Date(isoString);
    },
  };
}

function createDbShim() {
  return {
    collection(name) {
      if (name === "publicConfig") {
        return {
          doc(id) {
            return {
              async get() {
                if (id !== "general") {
                  return {
                    exists: false,
                    data() {
                      return null;
                    },
                  };
                }
                const config = await apiFetch("/api/public/config");
                return {
                  exists: true,
                  data() {
                    return config;
                  },
                };
              },
            };
          },
        };
      }

      if (name === "availabilitySlots") {
        return {
          orderBy() {
            return {
              async get() {
                const slots = await apiFetch("/api/public/slots");
                return {
                  docs: slots.map((slot) => ({
                    id: slot.id,
                    data() {
                      return {
                        ...slot,
                        startAt: toTimestampLike(slot.startAt),
                        endAt: toTimestampLike(slot.endAt),
                      };
                    },
                  })),
                };
              },
            };
          },
        };
      }

      throw new Error(`지원하지 않는 컬렉션입니다: ${name}`);
    },
  };
}

function createFunctionsShim() {
  return {
    httpsCallable(name) {
      return async (data) => ({
        data: await apiFetch(`/api/call/${name}`, {
          method: "POST",
          body: JSON.stringify(data || {}),
        }),
      });
    },
  };
}

async function initFirebase() {
  state.db = createDbShim();
  state.functions = createFunctionsShim();
}

async function init() {
  cacheElements();
  bindEvents();
  if (els.professorDirectoryInput) {
    els.professorDirectoryInput.placeholder = "prof-1,김교수,010-1111-1111,국문학과,1111\nprof-2,박교수,010-2222-2222,경영학과,2222";
  }
  if (els.rosterInput) {
    els.rosterInput.placeholder = "20260001,홍길동,prof-1\n20260002,김영희,prof-1\n20260003,박민수,prof-2";
  }
  els.calendarMonth.value = new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    timeZone: "Asia/Seoul",
  }).format(new Date());

  const url = new URL(window.location.href);
  const linkedStudentNo = url.searchParams.get("studentNo");
  const linkedProfessorId = url.searchParams.get("professorId");
  if (linkedStudentNo) {
    els.lookupStudentNo.value = linkedStudentNo;
  }
  if (linkedProfessorId) {
    state.selectedProfessorId = linkedProfessorId;
  }

  await initFirebase();
  await loadPublicData();
  els.alternatePhase.value = inferReminderPhase();

  if (state.systemAdminCode) {
    els.systemAdminCode.value = state.systemAdminCode;
    try {
      await unlockSystemPanel();
    } catch (error) {
      sessionStorage.removeItem("omtSystemAdminCode");
      state.systemAdminCode = "";
      setInlineMessage(els.systemAuthMessage, "저장된 시스템 관리자 인증이 만료되었습니다.", true);
    }
  }

  if (state.adminCode) {
    els.adminCode.value = state.adminCode;
    if (state.adminProfessorId) {
      els.adminProfessorSelect.value = state.adminProfessorId;
    }
    try {
      await unlockAdminPanel();
    } catch (error) {
      sessionStorage.removeItem("omtAdminCode");
      sessionStorage.removeItem("omtAdminProfessorId");
      state.adminCode = "";
      state.adminProfessorId = "";
      setInlineMessage(els.adminAuthMessage, "저장된 관리자 인증이 만료되었습니다.", true);
    }
  }
}

init().catch((error) => {
  console.error(error);
  document.body.innerHTML = `<div class="page-shell"><div class="panel">초기화에 실패했습니다. 정적 웹 호스팅과 API 서버 설정을 확인해 주세요.</div></div>`;
});
