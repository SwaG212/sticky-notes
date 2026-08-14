'use strict';

(function () {
  const api = window.assistantAPI;

  const els = {
    stateBadge: document.getElementById('state-badge'),
    micIndicator: document.getElementById('mic-indicator'),
    configWarning: document.getElementById('config-warning'),
    history: document.getElementById('dialog-history'),
    lastRecognition: document.getElementById('last-recognition'),
    goal: document.getElementById('plan-goal'),
    actions: document.getElementById('plan-actions'),
    missing: document.getElementById('plan-missing'),
    assumptions: document.getElementById('plan-assumptions'),
    execSteps: document.getElementById('exec-steps'),
    execSummary: document.getElementById('exec-summary'),
    input: document.getElementById('text-input'),
    send: document.getElementById('btn-send'),
    pause: document.getElementById('btn-pause'),
    resume: document.getElementById('btn-resume'),
    stop: document.getElementById('btn-stop'),
  };

  const ACTIVE_STATES = new Set(['LISTENING', 'TRANSCRIBING', 'REASONING', 'CLARIFYING',
    'AWAITING_CONFIRMATION', 'EXECUTING', 'REPORTING', 'CANCELLING']);

  /** 当前状态 → 按钮可用性 */
  function updateControls(state) {
    els.stateBadge.textContent = state;
    els.stateBadge.dataset.state = state;
    const busy = state === 'REASONING' || state === 'EXECUTING' || state === 'CANCELLING' || state === 'REPORTING';
    els.pause.disabled = state !== 'EXECUTING';
    els.resume.disabled = state !== 'PAUSED';
    els.stop.disabled = !ACTIVE_STATES.has(state);
    els.input.disabled = busy || state === 'PAUSED' || state === 'CANCELLING';
    els.send.disabled = busy || state === 'PAUSED' || state === 'CANCELLING';
  }

  function appendDialog(role, content, kind) {
    els.lastRecognition.classList.add('hidden');
    const row = document.createElement('div');
    row.className = `msg ${role} ${kind || ''}`;
    const label = document.createElement('span');
    label.className = 'msg-label';
    label.textContent = role === 'user' ? '你' : '小智';
    const body = document.createElement('span');
    body.className = 'msg-body';
    body.textContent = content;
    row.appendChild(label);
    row.appendChild(body);
    els.history.appendChild(row);
    els.history.scrollTop = els.history.scrollHeight;
  }

  function renderPlan(plan) {
    if (!plan) {
      els.goal.textContent = '—';
      els.goal.classList.add('empty');
      els.actions.innerHTML = '';
      els.missing.textContent = '';
      els.assumptions.textContent = '';
      return;
    }
    els.goal.textContent = plan.goal;
    els.goal.classList.remove('empty');
    els.actions.innerHTML = '';
    plan.actions.forEach((a, i) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'action-name';
      name.textContent = `${i + 1}. ${a.type}`;
      const args = document.createElement('span');
      args.className = 'action-args';
      args.textContent = JSON.stringify(a.args);
      li.appendChild(name);
      li.appendChild(args);
      els.actions.appendChild(li);
    });
    els.missing.textContent = plan.missingFields.length
      ? `缺失字段：${plan.missingFields.join('、')}`
      : '';
    els.missing.classList.toggle('warn', plan.missingFields.length > 0);
    els.assumptions.textContent = plan.assumptions.length
      ? `待确认假设：${plan.assumptions.join('；')}`
      : '';
    els.assumptions.classList.toggle('warn', plan.assumptions.length > 0);
  }

  function renderExecution(result) {
    els.execSteps.innerHTML = '';
    const steps = [];
    for (const c of result.completed || []) {
      steps.push({ label: `${c.actionType} —— ${c.summary || '完成'}`, cls: 'done' });
    }
    for (const f of result.failed || []) {
      steps.push({ label: `${f.actionType} —— 失败（${f.code}）`, cls: 'fail' });
    }
    for (const i of result.interrupted || []) {
      steps.push({ label: `${i.actionType} —— 中断`, cls: 'interrupt' });
    }
    for (const n of result.notExecuted || []) {
      steps.push({ label: `${n} —— 未执行`, cls: 'skip' });
    }
    steps.forEach((s) => {
      const li = document.createElement('li');
      li.className = `exec-step ${s.cls}`;
      li.textContent = s.label;
      els.execSteps.appendChild(li);
    });
    els.execSummary.textContent = `状态：${result.status}（已完成 ${(result.completed || []).length}，失败 ${(result.failed || []).length}，中断 ${(result.interrupted || []).length}，未执行 ${(result.notExecuted || []).length}）`;
  }

  function showError(message) {
    appendDialog('assistant', `[错误] ${message}`, 'error');
  }

  async function handleUserText() {
    const text = els.input.value.trim();
    if (!text) return;
    els.input.value = '';
    const res = await api.startText(text);
    if (!res.ok) {
      showError(res.error.message);
    }
  }

  async function handleResponse() {
    const text = els.input.value.trim();
    if (!text) return;
    els.input.value = '';
    const res = await api.sendResponse(text);
    if (!res.ok) {
      showError(res.error.message);
    }
  }

  function submit() {
    if (els.send.disabled) return;
    handleUserText();
  }

  api.onEvent((event, payload) => {
    if (event === 'state_changed') {
      updateControls(payload.to);
    } else if (event === 'dialog') {
      appendDialog(payload.role, payload.content, payload.kind);
    } else if (event === 'plan_updated') {
      renderPlan(payload);
    } else if (event === 'execution_update') {
      renderExecution(payload.result);
    } else if (event === 'control' && payload.action === 'pause_requested') {
      appendDialog('assistant', '正在等待当前步骤结束并暂停……', 'paused');
    }
  });

  els.send.addEventListener('click', submit);
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  els.stop.addEventListener('click', () => api.stop('ui_button'));
  els.pause.addEventListener('click', async () => {
    const res = await api.pause();
    if (!res.ok) showError(res.error.message);
  });
  els.resume.addEventListener('click', async () => {
    const res = await api.resume();
    if (!res.ok) showError(res.error.message);
  });

  (async function init() {
    const cfg = await api.getConfig();
    if (!cfg.ok || !cfg.data.hasApiKey) {
      els.configWarning.classList.remove('hidden');
    }
    const snap = await api.getSnapshot();
    if (snap.ok) {
      updateControls(snap.data.state);
      renderPlan(snap.data.currentPlan);
      if (snap.data.lastRecognition) {
        els.lastRecognition.textContent = `最近识别：${snap.data.lastRecognition}`;
        els.lastRecognition.classList.remove('hidden');
      }
    }
  })();
})();
