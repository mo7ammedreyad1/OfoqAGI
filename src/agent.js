// agent.js — OFOQ AGI Agent v8.0
// AGENT_MODE=agent (default) | AGENT_MODE=scheduler
// لا Firebase — كل شيء في ملفات markdown محلية على GitHub repo

import { execSync }                                     from 'child_process';
import { readFileSync, writeFileSync, existsSync,
         unlinkSync, mkdirSync, appendFileSync }        from 'fs';
import { join, dirname }                                from 'path';
import { fileURLToPath }                                from 'url';
import { tmpdir }                                       from 'os';

const __dir       = dirname(fileURLToPath(import.meta.url));
const ROOT        = join(__dir, '..');
const MEMORY_DIR  = join(ROOT, 'memory');
const SESSIONS_DIR= join(MEMORY_DIR, 'sessions');
const SKILLS_FILE = join(ROOT, 'skills', 'skills.md');
const CORE_FILE   = join(MEMORY_DIR, 'core.md');
const INDEX_FILE  = join(MEMORY_DIR, 'index.md');
const TASK_FILE   = join(ROOT, 'tasks', 'task_LIVE.md');
const TASKS_DIR   = join(ROOT, 'tasks');

// ── Env ─────────────────────────────────────────────────────────
const GEMINI_KEY   = process.env.GEMINI_API_KEY;
const AGENT_MODE   = process.env.AGENT_MODE || 'agent';
const INPUT_MSG    = process.env.INPUT_MESSAGE;   // للمحادثات العادية
const SCHED_ID     = process.env.SCHEDULE_ID;     // للـ scheduler

const GEMINI_URL   = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`;
const MAX_ROUNDS   = 20;

if (!GEMINI_KEY) { console.error('❌ GEMINI_API_KEY missing'); process.exit(1); }

// ================================================================
// SECTION 1 — FILE HELPERS
// ================================================================

function readFile(path) {
  try { return existsSync(path) ? readFileSync(path, 'utf8') : ''; }
  catch { return ''; }
}

function writeFile(path, content) {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, content, 'utf8');
  } catch (e) { log('error', `writeFile(${path}): ${e.message}`); }
}

function appendFile(path, line) {
  try {
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, '\n' + line, 'utf8');
  } catch {}
}

function deleteFile(path) {
  try { if (existsSync(path)) unlinkSync(path); } catch {}
}

// ── Task scratchpad ──────────────────────────────────────────────
function readTask()          { return readFile(TASK_FILE); }
function writeTask(content)  { writeFile(TASK_FILE, content); log('task', `write (${content.length}ch)`); }
function clearTask()         { deleteFile(TASK_FILE); }

// ── Memory ───────────────────────────────────────────────────────
function readCore()          { return readFile(CORE_FILE); }
function readIndex()         { return readFile(INDEX_FILE); }
function readSkills()        { return readFile(SKILLS_FILE); }

function updateCore(content) { writeFile(CORE_FILE, content); log('memory', 'core.md updated'); }

function appendIndex(line) {
  appendFile(INDEX_FILE, line);
  log('memory', `index.md ← ${line.slice(0, 80)}`);
}

function saveSession({ title, category, summary, key_results = '', notes = '' }) {
  const now   = new Date().toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' });
  const date  = new Date().toISOString().slice(0, 10);
  const slug  = title.replace(/[^a-zA-Z0-9\u0600-\u06FF]/g, '_').slice(0, 40);
  const fname = `${date}_${slug}.md`;
  const path  = join(SESSIONS_DIR, fname);
  const content = [
    `# Session: ${title}`,
    `Date: ${now}`,
    `Category: ${category}`,
    '',
    `## ملخص`,
    summary,
    '',
    key_results ? `## نتائج مهمة\n${key_results}` : '',
    notes       ? `## ملاحظات للمستقبل\n${notes}` : '',
  ].filter(l => l !== undefined).join('\n');
  writeFile(path, content);
  const idxLine = `${date} | ${category} | ${summary.split('\n')[0].slice(0, 100)}`;
  appendIndex(idxLine);
  log('memory', `session saved → ${fname}`);
}

// ================================================================
// SECTION 2 — LOGGING
// ================================================================

function log(tag, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`[${ts}] [${tag.toUpperCase()}] ${msg}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ================================================================
// SECTION 3 — SHELL EXECUTION
// ================================================================

function executeShell(script) {
  const id      = `ofoq_${Date.now()}`;
  const tmpFile = join(tmpdir(), `${id}.sh`);
  writeFileSync(tmpFile, `#!/bin/bash\nset -eo pipefail\n\n${script}\n`, 'utf8');

  let stdout = '', stderr = '';
  try {
    stdout = execSync(`bash "${tmpFile}"`, {
      maxBuffer: 10 * 1024 * 1024,
      encoding:  'utf8',
      cwd:       ROOT,
      env:       { ...process.env, TERM: 'xterm-256color' },
    });
    return { success: true, exit_code: 0, stdout: stdout.slice(0, 4000), stderr: '' };
  } catch (e) {
    stderr = `${e.stderr || ''}${e.message || ''}`;
    stdout = e.stdout || '';
    return {
      success:   false,
      exit_code: e.status || 1,
      stdout:    stdout.slice(0, 2000),
      stderr:    stderr.slice(0, 1000),
      error:     stderr.split('\n').filter(Boolean).slice(-3).join(' | '),
    };
  } finally {
    try { if (existsSync(tmpFile)) unlinkSync(tmpFile); } catch {}
  }
}

// ================================================================
// SECTION 4 — GEMINI API
// ================================================================

async function callGemini(messages, systemInstruction, attempt = 0) {
  // تنظيف الرسائل — Gemini لا يقبل consecutive same roles
  const clean = [];
  for (const m of messages) {
    const last = clean[clean.length - 1];
    if (last && last.role === m.role) {
      last.parts[0].text += '\n' + m.parts[0].text;
    } else {
      clean.push({ role: m.role, parts: [{ text: m.parts[0].text }] });
    }
  }

  let resp;
  try {
    resp = await fetch(GEMINI_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: clean,
        systemInstruction: { parts: [{ text: systemInstruction }] },
        generationConfig:  { temperature: 0.4, maxOutputTokens: 8192 },
      }),
    });
  } catch (e) {
    if (attempt < 5) {
      const wait = [1000, 3000, 6000, 12000, 24000][attempt];
      log('warn', `fetch failed → retry ${wait}ms (attempt ${attempt+1})`);
      await sleep(wait);
      return callGemini(messages, systemInstruction, attempt + 1);
    }
    throw new Error(`Gemini unreachable: ${e.message}`);
  }

  if (resp.status === 429 || resp.status === 503) {
    if (attempt < 5) {
      const wait = [2000, 5000, 10000, 20000, 40000][attempt];
      log('warn', `HTTP ${resp.status} → retry ${wait}ms`);
      await sleep(wait);
      return callGemini(messages, systemInstruction, attempt + 1);
    }
  }

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Gemini HTTP ${resp.status}: ${JSON.stringify(err).slice(0, 200)}`);
  }

  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
}

// ================================================================
// SECTION 5 — ACTION PARSER
// ================================================================

function parseActions(text) {
  const re      = /<action\s+type=["']([^"']+)["'][^>]*>([\s\S]*?)<\/action>/gi;
  const actions = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const type = m[1].toLowerCase().trim();
    const body = m[2].trim();
    actions.push({ type, body, raw: m[0] });
  }
  return actions;
}

// ================================================================
// SECTION 6 — SYSTEM INSTRUCTION BUILDER
// ================================================================

function buildSystem(skillsMd, coreMd, indexMd) {
  const taskNote = readTask();
  const now      = new Date().toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' });
  return [
    skillsMd,
    '\n\n---\n## ذاكرتك الجوهرية (memory/core.md)\n```\n',
    coreMd,
    '\n```\n\n## فهرس الـ Sessions (memory/index.md)\n```\n',
    indexMd,
    '\n```',
    taskNote ? `\n\n## مفكّرتك الحالية (tasks/task_LIVE.md)\n\`\`\`markdown\n${taskNote}\n\`\`\`` : '',
    `\n\n**الوقت الحالي:** ${now}`,
  ].join('');
}

// ================================================================
// SECTION 7 — REACT LOOP (Plan·Execute·Reflect)
// ================================================================

async function reactLoop(userMsg, history, skillsMd) {
  const messages     = [...history, { role: 'user', parts: [{ text: userMsg }] }];
  const resultParts  = [];
  let finalResponse  = null;
  let coreUpdated    = false;
  let sessionSaved   = false;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    log('loop', `Round ${round + 1}/${MAX_ROUNDS}`);

    const coreMd  = readCore();
    const indexMd = readIndex();
    const sysInst = buildSystem(skillsMd, coreMd, indexMd);

    const assistantText = await callGemini(messages, sysInst);
    if (!assistantText) { log('warn', 'Empty response from Gemini'); break; }

    // أضف الرد للـ messages
    messages.push({ role: 'model', parts: [{ text: assistantText }] });

    const actions = parseActions(assistantText);

    if (!actions.length) {
      // لا actions → هذا هو الرد النهائي
      finalResponse = assistantText.replace(/<action[\s\S]*?<\/action>/gi, '').trim();
      log('loop', `Final response (round ${round + 1})`);
      break;
    }

    // نفّذ كل الـ actions
    for (const action of actions) {
      log('action', `type=${action.type} body=${action.body.slice(0,60)}`);

      // ── write_task ───────────────────────────────────────────
      if (action.type === 'write_task') {
        writeTask(action.body);
        resultParts.push(`[write_task] ✅ كُتبت (${action.body.length}ch)`);
      }

      // ── shell ────────────────────────────────────────────────
      else if (action.type === 'shell') {
        const res = executeShell(action.body);
        log('shell', `exit=${res.exit_code} stdout=${res.stdout.slice(0,80)}`);
        if (res.success) {
          const out = `[shell] ✅\n\`\`\`\n${res.stdout.slice(0, 2000)}\n\`\`\``;
          resultParts.push(out);
          // أضف النتيجة للـ messages كـ user turn حتى يراها الـ model
          messages.push({ role: 'user', parts: [{ text: `نتيجة shell:\n${res.stdout.slice(0, 2000)}` }] });
        } else {
          const errMsg = `[shell] ❌ exit=${res.exit_code}\nstderr: ${res.error}\nstdout: ${res.stdout.slice(0,500)}`;
          resultParts.push(errMsg);
          messages.push({ role: 'user', parts: [{ text: errMsg }] });
        }
      }

      // ── save_session ─────────────────────────────────────────
      else if (action.type === 'save_session') {
        try {
          const params = JSON.parse(action.body);
          saveSession(params);
          clearTask();
          sessionSaved = true;
          resultParts.push('[save_session] ✅ session محفوظ، task_LIVE.md محذوف');
        } catch (e) {
          resultParts.push(`[save_session] ❌ JSON غير صالح: ${e.message}`);
        }
      }

      // ── update_core ──────────────────────────────────────────
      else if (action.type === 'update_core') {
        updateCore(action.body);
        coreUpdated = true;
        resultParts.push('[update_core] ✅ memory/core.md محدَّث');
      }

      // ── schedule ─────────────────────────────────────────────
      else if (action.type === 'schedule') {
        try {
          const p = JSON.parse(action.body);
          handleScheduleCreate(p);
          resultParts.push(`[schedule] ✅ "${p.name}" مجدولة`);
        } catch (e) {
          resultParts.push(`[schedule] ❌ ${e.message}`);
        }
      }
    }

    // نص خارج الـ actions = رد جزئي — نحتفظ به كـ finalResponse مؤقت
    const textOutside = assistantText.replace(/<action[\s\S]*?<\/action>/gi, '').trim();

    // لو النص موجود وليس هناك shell actions معلّقة → هذا هو الرد النهائي
    const hasShell = actions.some(a => a.type === 'shell');
    if (textOutside && !hasShell && actions.length > 0) {
      finalResponse = textOutside;
      break;
    }

    // أضف ملخص Actions لـ messages ليعرف النموذج ما تم
    if (resultParts.length > 0) {
      const summary = resultParts.join('\n\n');
      messages.push({ role: 'user', parts: [{ text: `نتائج الـ actions:\n${summary}` }] });
      resultParts.length = 0;
    }
  }

  // Fallback — لو انتهت الـ rounds بدون رد نهائي صريح
  if (!finalResponse) {
    const lastModel = [...messages].reverse().find(m => m.role === 'model');
    if (lastModel) {
      finalResponse = lastModel.parts[0].text
        .replace(/<action[\s\S]*?<\/action>/gi, '').trim()
        || 'تم تنفيذ المهمة.';
    }
  }

  return { finalResponse, coreUpdated, sessionSaved };
}

// ================================================================
// SECTION 8 — SCHEDULE MANAGEMENT
// ================================================================

function parseCronNext(expr, after = new Date(), tz = 'Africa/Cairo') {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron غير صالح: "${expr}"`);
  const [minP, hrP, domP, monP, dowP] = parts;

  const matches = (part, val, lo, hi) => {
    if (part === '*') return true;
    for (const seg of part.split(',')) {
      if (seg.includes('/')) {
        const [rng, step] = seg.split('/');
        const s = parseInt(step);
        const [a, b] = rng === '*' ? [lo, hi] : rng.split('-').map(Number);
        for (let v = a; v <= b; v += s) if (v === val) return true;
      } else if (seg.includes('-')) {
        const [a, b] = seg.split('-').map(Number);
        if (val >= a && val <= b) return true;
      } else if (parseInt(seg) === val) return true;
    }
    return false;
  };

  const d = new Date(after.getTime() + 60_000);
  d.setSeconds(0, 0);
  for (let i = 0; i < 527_040; i++) {
    const fmt   = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit',
      hour:'2-digit', minute:'2-digit', hour12: false,
    }).formatToParts(d);
    const g     = t => parseInt(fmt.find(p=>p.type===t)?.value ?? '0');
    const [mn, hr, dom, mon] = [g('minute'), g('hour'), g('day'), g('month')];
    const dow   = new Date(d.toLocaleString('en-US',{timeZone:tz})).getDay();
    if (matches(minP,mn,0,59) && matches(hrP,hr,0,23) &&
        matches(domP,dom,1,31) && matches(monP,mon,1,12) &&
        matches(dowP,dow,0,6)) return new Date(d);
    d.setTime(d.getTime() + 60_000);
  }
  return null;
}

function handleScheduleCreate(params) {
  const { name, cron, task_prompt, timezone = 'Africa/Cairo' } = params;
  const nextRun = parseCronNext(cron, new Date(), timezone);
  // أضف للـ core.md تحت ## جداول نشطة
  let core = readCore();
  const schedBlock = [
    `\nSCHEDULE_${Date.now()}:`,
    `  name: ${name}`,
    `  cron: "${cron}"`,
    `  task_prompt: "${task_prompt}"`,
    `  last_run: null`,
    `  next_run: ${nextRun?.toISOString() ?? 'null'}`,
    `  timezone: ${timezone}`,
    `  status: active`,
  ].join('\n');
  if (!core.includes('## جداول نشطة')) core += '\n\n## جداول نشطة\n';
  core += schedBlock;
  updateCore(core);
  log('schedule', `Created "${name}" → next: ${nextRun?.toISOString()}`);
}

// ================================================================
// SECTION 9 — SCHEDULER MODE
// ================================================================

async function getDueSchedules() {
  const core = readCore();
  const now  = new Date();
  const re   = /SCHEDULE_(\d+):\n([\s\S]*?)(?=\nSCHEDULE_|\n## |\n# |$)/g;
  const due  = [];
  let m;
  while ((m = re.exec(core)) !== null) {
    const block = m[2];
    const get = (k) => { const r = new RegExp(`${k}: (.+)`); return block.match(r)?.[1]?.trim() ?? ''; };
    if (get('status') !== 'active') continue;
    const nextRun = get('next_run');
    if (!nextRun || nextRun === 'null') continue;
    if (new Date(nextRun) <= now) {
      due.push({
        id:          `SCHEDULE_${m[1]}`,
        name:        get('name'),
        cron:        get('cron').replace(/^"|"$/g,''),
        task_prompt: get('task_prompt').replace(/^"|"$/g,''),
        timezone:    get('timezone') || 'Africa/Cairo',
      });
    }
  }
  return due;
}

async function runScheduledTask(sched, skillsMd) {
  log('scheduler', `Running: "${sched.name}"`);
  const coreMd  = readCore();
  const indexMd = readIndex();
  const taskMsg = `[مهمة مجدولة تلقائية]\nالاسم: ${sched.name}\n\n${sched.task_prompt}`;
  const { finalResponse } = await reactLoop(taskMsg, [], skillsMd);

  // احفظ النتيجة كـ session
  saveSession({
    title:       `مجدولة: ${sched.name}`,
    category:    'schedule',
    summary:     (finalResponse || 'لم يتم توليد رد').slice(0, 300),
    key_results: finalResponse?.slice(0, 500) || '',
    notes:       `تشغيل تلقائي — cron: ${sched.cron}`,
  });

  // حدّث next_run
  const nextRun = parseCronNext(sched.cron, new Date(), sched.timezone);
  let core = readCore();
  core = core.replace(
    new RegExp(`(${sched.id}:[\\s\\S]*?next_run: )[^\\n]+`),
    `$1${nextRun?.toISOString() ?? 'null'}`
  ).replace(
    new RegExp(`(${sched.id}:[\\s\\S]*?last_run: )[^\\n]+`),
    `$1${new Date().toISOString()}`
  );
  updateCore(core);
  log('scheduler', `Done: "${sched.name}" → next: ${nextRun?.toISOString()}`);
}

// ================================================================
// SECTION 10 — OUTPUT (stdout للـ frontend)
// ================================================================

function output(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// ================================================================
// SECTION 11 — MAIN AGENT
// ================================================================

async function mainAgent() {
  if (!INPUT_MSG) {
    log('error', 'INPUT_MESSAGE env var is required');
    process.exit(1);
  }

  log('agent', `Starting — msg: "${INPUT_MSG.slice(0, 80)}"`);

  const skillsMd = readSkills();
  if (!skillsMd) { log('error', 'skills/skills.md not found'); process.exit(1); }

  // قراءة تاريخ المحادثة — HISTORY قد يكون string أو array
  let historyRaw = [];
  if (process.env.HISTORY) {
    try {
      const parsed = JSON.parse(process.env.HISTORY);
      historyRaw = Array.isArray(parsed) ? parsed : [];
    } catch { historyRaw = []; }
  }
  const history = historyRaw.map(m => ({
    role:  m.role === 'user' ? 'user' : 'model',
    parts: [{ text: String(m.content || '') }],
  }));

  output({ type: 'status', status: 'thinking' });

  // ── Quick Thinking Pass ─────────────────────────────────────────
  // تفكير أولي سريع قبل الـ loop — يساعد النموذج يفهم المهمة ويخطط
  const coreMd  = readCore();
  const indexMd = readIndex();
  const thinkPrompt = `أنت أفق. المستخدم طلب:
"${INPUT_MSG}"

ذاكرتك الجوهرية:
${coreMd.slice(0, 800)}

فهرس الـ sessions:
${indexMd.slice(0, 400)}

في جملة واحدة: ما الطريقة المثلى لتنفيذ هذا الطلب؟ وهل تحتاج shell؟ وهل له علاقة بـ sessions سابقة؟`;

  const thinkResp = await callGemini(
    [{ role: 'user', parts: [{ text: thinkPrompt }] }],
    'أنت مساعد تحليلي. فكّر بصوت عالٍ بإيجاز ثم أجب في 3 أسطر كحد أقصى.',
  ).catch(() => '');

  if (thinkResp) {
    output({ type: 'thinking', text: thinkResp });
    log('think', thinkResp.slice(0, 120));
  }

  // ── Main ReAct Loop ─────────────────────────────────────────────
  const { finalResponse, coreUpdated, sessionSaved } = await reactLoop(
    INPUT_MSG, history, skillsMd
  );

  if (!finalResponse) {
    output({ type: 'error', message: 'لم يصل الـ agent لرد نهائي' });
    process.exit(1);
  }

  // ── Auto-save session إذا لم يفعلها الـ AI بنفسه ─────────────────
  if (!sessionSaved) {
    const date     = new Date().toISOString().slice(0, 10);
    const category = guessCategory(INPUT_MSG);
    saveSession({
      title:       INPUT_MSG.slice(0, 50),
      category,
      summary:     finalResponse.slice(0, 250),
      key_results: '',
      notes:       '',
    });
    log('agent', 'Auto-saved session');
  }

  output({ type: 'response', text: finalResponse });
  output({ type: 'meta', core_updated: coreUpdated, session_saved: true });
  log('agent', `Done — core_updated=${coreUpdated}`);
}

/** تخمين فئة المهمة من نص الرسالة */
function guessCategory(msg) {
  const m = msg.toLowerCase();
  if (/python|كود|script|برمج|debug/.test(m))    return 'code';
  if (/ابحث|اقرأ|اجلب|اعرف|ما هو|خبر/.test(m)) return 'research';
  if (/حلل|تقرير|قارن|أداء/.test(m))             return 'analysis';
  if (/جدول|كل يوم|كل أسبوع|ذكّر/.test(m))       return 'schedule';
  if (/token|config|إعداد|ربط/.test(m))           return 'config';
  return 'other';
}

// ================================================================
// SECTION 12 — MAIN SCHEDULER
// ================================================================

async function mainScheduler() {
  log('scheduler', `Starting — ${new Date().toISOString()}`);

  const skillsMd = readSkills();
  if (!skillsMd) { log('error', 'skills/skills.md not found'); process.exit(1); }

  const due = await getDueSchedules();
  log('scheduler', `Due schedules: ${due.length}`);

  if (!due.length) { log('scheduler', 'No due schedules — done.'); return; }

  for (const sched of due) {
    try {
      await runScheduledTask(sched, skillsMd);
      await sleep(3000);
    } catch (e) {
      log('error', `Scheduler failed for "${sched.name}": ${e.message}`);
    }
  }

  log('scheduler', 'All done.');
}

// ================================================================
// ENTRYPOINT
// ================================================================

log('agent', `Mode: ${AGENT_MODE}`);

if (AGENT_MODE === 'scheduler') {
  mainScheduler().catch(e => {
    log('error', `Scheduler fatal: ${e.message}`);
    process.exit(1);
  });
} else {
  mainAgent().catch(e => {
    log('error', `Agent fatal: ${e.message}`);
    output({ type: 'error', message: e.message });
    process.exit(1);
  });
}
