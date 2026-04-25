# OFOQ AGI Agent v8.0

مساعد ذكاء اصطناعي عام متكامل — بدون قيود، بدون Firebase، كل شيء في ملفات.

---

## المعمارية

```
ofoq-agent/
├── src/agent.js              ← الدماغ الوحيد (Agent + Scheduler)
├── memory/
│   ├── core.md               ← الذاكرة الجوهرية الدائمة
│   ├── index.md              ← فهرس كل الـ sessions (سطر لكل session)
│   └── sessions/             ← ملف لكل session (موجز + نتائج)
├── skills/skills.md          ← system prompt كامل
├── tasks/task_LIVE.md        ← scratchpad مؤقت (يُحذف بعد كل session)
├── public/index.html         ← واجهة المستخدم
└── .github/workflows/
    ├── agent.yml             ← محادثات عادية
    └── scheduler.yml         ← مهام مجدولة (كل دقيقة)
```

---

## معمارية التفكير — 6 طبقات

```
PERCEIVE → PLAN → EXECUTE → REFLEXION → SYNTHESIZE → LEARN
```

1. **PERCEIVE** — يقرأ `memory/core.md` + `memory/index.md`
2. **PLAN** — يكتب خطة كاملة في `tasks/task_LIVE.md` قبل أي shell
3. **EXECUTE** — خطوة واحدة في كل shell action
4. **REFLEXION** — بعد كل نتيجة: هل منطقية؟ لماذا نجح/فشل؟
5. **SYNTHESIZE** — رد نهائي مبني على task_LIVE.md + الذاكرة
6. **LEARN** — يحفظ session، يحدّث index.md، يحذف task_LIVE.md

---

## الإعداد

### 1. GitHub Secrets
```
GEMINI_API_KEY → مفتاح Gemini API
```

### 2. إعداد Frontend
في `public/index.html` عدّل:
```js
const CONFIG = {
  GITHUB_OWNER: 'your-username',
  GITHUB_REPO:  'ofoq-agent',
  GITHUB_TOKEN: 'ghp_...',   // PAT بصلاحية workflow + contents
};
```

### 3. الـ Actions المتاحة للـ AI

| Action | الوظيفة |
|---|---|
| `write_task` | كتابة خطة + نتائج مؤقتة (قبل أي shell) |
| `shell` | تنفيذ bash على Ubuntu VM (بدون timeout) |
| `save_session` | حفظ ملخص في memory/sessions/ |
| `update_core` | تحديث الذاكرة الجوهرية |
| `schedule` | إنشاء مهمة مجدولة متكررة |

---

## مثال — كيف يعمل

**المستخدم:** "حلل أداء BTC أسبوعياً"

```
Round 1:
  [write_task] خطة: 1.جلب سعر حالي 2.جلب قبل 7أيام 3.حساب التغيير

Round 2:
  [shell] جلب الأسعار من CoinGecko
  نتيجة: BTC=$63,000

Round 3:
  [shell] جلب السعر قبل 7 أيام
  نتيجة: BTC=$61,200

Round 4 (REFLEXION):
  [write_task] حدّث: BTC +2.9% — أداء إيجابي هذا الأسبوع

Round 5:
  رد نهائي: تقرير مفصل

Round 6:
  [save_session] حفظ الملخص
  [update_core] لو تعلّم شيئاً جديداً
```

---

## الفرق عن الإصدارات السابقة

| السابق | v8 |
|---|---|
| Firebase Firestore | ملفات markdown فقط |
| soul.md + tools.md منفصلين | skills.md موحّد |
| ReAct loop بسيط | Plan·Execute·Reflect·Learn |
| لا تعلّم بين sessions | كل session يُعلّم الـ agent |
| timeout على shell | بدون أي timeout |
| محدود بنشر المحتوى | أي مهمة بدون قيود |
