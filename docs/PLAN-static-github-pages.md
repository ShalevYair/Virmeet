# תכנון: הסבת Virmeet לאתר סטטי על GitHub Pages

> **מסמך זה הוא הוראות ביצוע.** הוא נכתב כדי שסוכן שנפתח בשיחה חדשה, בלי שום
> הקשר קודם, יוכל לקרוא אותו ולבצע את העבודה מקצה לקצה. קרא אותו במלואו לפני
> שאתה נוגע בקוד.

**ענף עבודה:** צור ענף חדש מ-`main` (למשל `claude/static-github-pages`).
**נקודת שחזור:** לפני שמתחילים, תייג את המצב הנוכחי — `git tag pre-static-rewrite` —
כדי שגרסת השרת תישאר נגישה אם ירצו לחזור אליה.

---

## 1. המטרה

Virmeet היום היא אפליקציית Next.js עם צד שרת: routes תחת `src/app/api/`, אחסון
בקבצי JSON על הדיסק (`data/`), וחילוץ טקסט מ-PDF/DOCX בספריות Node. GitHub Pages
לא מריץ קוד ואין לו דיסק לכתיבה, ולכן האפליקציה במצבה הנוכחי לא יכולה להתארח שם.

**המטרה: להפוך את Virmeet לאתר סטטי לחלוטין** שרץ כולו בדפדפן ומתארח ב-GitHub
Pages, בלי לאבד אף יכולת מהותית. בנוסף — ובאותה הזדמנות — להוסיף שכבת
**פרסונות מבוססות-JSON בריפו**: תיקייה של קבצי JSON לפרסונות, תיקייה של קבצי
רקע, וקישור ביניהן בתוך ה-JSON עצמו.

### מה המשתמש יוכל לעשות בסוף

1. לגלוש ל-URL ציבורי (`https://<user>.github.io/Virmeet/`) ולהשתמש באפליקציה.
2. להזין מפתחות API של Anthropic ו/או Gemini במסך ההגדרות (נשמרים ב-`localStorage`).
3. לקבל פרסונות בסיס מוכנות שנטענות אוטומטית מהריפו בכניסה הראשונה.
4. **לייצא פרסונה ל-JSON** ולשמור אותה אצלו במחשב.
5. **לייבא פרסונה מ-JSON** — קובץ שהוריד, ערך ידנית, או קיבל ממישהו.
6. **להעלות קבצי JSON של פרסונות ישירות ל-GitHub** (דרך הממשק של GitHub) —
   ובכניסה הבאה לאתר הן יופיעו.
7. **להעלות קבצי רקע ישירות ל-GitHub** ולשייך אותם לפרסונה מתוך ה-JSON שלה.

### מה נשאר בדיוק כמו שהוא

מכונת המצבים של הפגישה (`prep → opening → discussion → convergence → extraction`),
בידוד שלב ה-`prep`, א-סימטריית הידע בין פרסונות, תקציב הקריאות לפרסונה,
הפרומטים בעברית, וסכימות ה-JSON של הפלט המובנה. **אין לשנות אף אחד מאלה.**

---

## 2. ארבע מלכודות שחייבים להכיר לפני שמתחילים

אלה ההבדלים שהופכים "אתר סטטי" ממתג קונפיגורציה לעבודה אמיתית. כל אחת מהן
תפיל את הבנייה או את האתר החי אם לא יטפלו בה.

### 2.1 נתיבים דינמיים (`[id]`) לא עובדים בייצוא סטטי

`output: 'export'` דורש `generateStaticParams()` לכל route דינמי, כלומר רשימה
של כל הנתיבים מראש בזמן בנייה. אבל המזהים כאן נוצרים בזמן ריצה על ידי המשתמש —
אי אפשר לדעת אותם מראש. ל-GitHub Pages אין גם מנגנון rewrite שיפנה נתיב לא מוכר
לדף קיים, אז כל כתובת כזו תחזיר 404.

**הפתרון:** להמיר את הנתיבים הדינמיים לפרמטרים ב-query string.

| היום | אחרי |
|---|---|
| `/personas/[id]` | `/personas/edit/?id=<id>` |
| `/meetings/[id]` | `/meetings/view/?id=<id>` |

הדפים החדשים קוראים את המזהה עם `useSearchParams()`.

> ⚠️ `useSearchParams()` בייצוא סטטי **חייב** להיות עטוף ב-`<Suspense>`, אחרת
> הבנייה נכשלת. עטוף את גוף הדף ב-`<Suspense fallback={<Skeleton />}>`.

### 2.2 אי אפשר לרשום תוכן של תיקייה מהדפדפן

הדפדפן לא יכול לשאול "אילו קבצים יש ב-`/seed/personas/`". אין API כזה באתר סטטי.
לכן חייבים **קובץ manifest** שמפרט את כל קבצי ה-seed במפורש.

וכדי שהמשתמש יוכל פשוט להעלות JSON ל-GitHub בלי לערוך manifest ידנית —
**ה-manifest נוצר אוטומטית בזמן הבנייה** על ידי סקריפט שסורק את התיקיות.
GitHub Actions מריץ את הבנייה בכל push, אז הזרימה היא:

```
העלאת JSON ל-GitHub  →  Action רץ  →  הסקריפט מייצר manifest  →  האתר נפרס
```

### 2.3 `basePath` — האתר יושב בתת-תיקייה

GitHub Pages מגיש את הפרויקט מ-`https://<user>.github.io/Virmeet/`, לא מהשורש.
לכן צריך `basePath: '/Virmeet'`. כל `fetch()` לקבצי seed חייב לכלול את הקידומת
הזו, אחרת הוא יפנה לשורש הדומיין ויקבל 404.

**הפתרון:** helper אחד, `seedUrl(relativePath)`, שכל קריאה עוברת דרכו. אסור
לכתוב `fetch('/seed/...')` ישירות בשום מקום.

### 2.4 קריאות ל-API מהדפדפן

- **Anthropic:** ה-SDK חוסם שימוש בדפדפן כברירת מחדל. צריך
  `new Anthropic({ apiKey, dangerouslyAllowBrowser: true })`. ה-SDK אמור לשלוח
  אוטומטית את הכותרת `anthropic-dangerous-direct-browser-access: true` שנדרשת
  ל-CORS. **יש לאמת את זה בפועל מול הדפדפן** — אם ה-CORS נכשל, זו נקודת עצירה
  שצריך לדווח עליה למשתמש, לא לעקוף.
- **Gemini:** `@google/genai` עובד בדפדפן ישירות, בלי דגל מיוחד.
- כלי חיפוש הרשת של שני הספקים רצים בצד שלהם, ולכן ממשיכים לעבוד כרגיל.

> **השלכת אבטחה שחייבים לתעד ב-README:** בגרסה הסטטית המפתח נשלח מהדפדפן ישירות
> לספק. אין יותר אופציה של מפתח בצד השרת. זה מודל האמון של כלי אישי — מתאים
> למכשיר שלך, לא למחשב משותף. אל תסתיר את זה.

---

## 3. מבנה תיקיות ה-seed

הכל תחת `public/` כדי שייוצא כקבצים סטטיים ויהיה נגיש ל-`fetch()`.

```
public/
  .nojekyll                      ← חובה! בלעדיו GitHub Pages מתעלם מתיקיית _next
  seed/
    manifest.json                ← נוצר אוטומטית — אל תערוך ידנית, ב-.gitignore
    org-settings.json
    personas/
      infra-architect.json
      software-architect.json
      cio.json
      project-manager.json
    meeting-types/
      kickoff.json
      architecture-review.json
      build-vs-buy.json
      postmortem.json
      quarterly-prioritization.json
    files/
      README.md                  ← הסבר קצר למי שמעלה קבצים דרך GitHub
      <קבצי רקע שהמשתמש מעלה>
```

### 3.1 סכימת JSON של פרסונה

```json
{
  "id": "infra-architect",
  "name": "ארכיטקט תשתיות",
  "role": "ארכיטקט תשתיות",
  "organization": "אגף טכנולוגיות, משרד התחבורה",
  "color": "#2563eb",
  "prompt": "אתה/את ארכיטקט תשתיות ב...\n\n## מי אתה\n...",
  "model": "claude-sonnet-5",
  "webAccess": false,
  "maxApiCalls": 8,
  "maxWebSearches": 3,
  "isActive": true,
  "files": ["files/legacy-dependencies.md", "files/incident-log-2024.pdf"],
  "embeddedFiles": [
    { "name": "הערות אישיות.txt", "text": "תוכן הקובץ כטקסט..." }
  ]
}
```

**שני מנגנוני קבצים, ובכוונה:**

| שדה | למה הוא קיים | מי כותב אותו |
|---|---|---|
| `files` | מערך נתיבים יחסיים ל-`public/seed/`. זה המנגנון ש**המשתמש** משתמש בו: מעלה קובץ ל-`public/seed/files/` דרך GitHub, ומוסיף את שמו כאן. | אדם, ידנית |
| `embeddedFiles` | טקסט מוטמע בתוך ה-JSON. זה מה שנוצר כשמייצאים מהאפליקציה פרסונה שיש לה קבצים שהועלו בדפדפן — כדי שהייצוא יהיה עצמאי. | האפליקציה, בייצוא |

שניהם אופציונליים. הטוען ממזג את שניהם ל-`files: AttachedFile[]` בזמן ריצה.

**חוקים מחייבים:**
- `id` חייב להיות **יציב וקריא לאדם** (kebab-case), לא UUID. עליו נשענת פעולת
  ה-upsert בייבוא חוזר — אם ה-id משתנה, נוצרת פרסונה כפולה.
- נתיבים ב-`files` הם **יחסיים ל-`public/seed/`** ואסור שיכילו `..`.
  יש לוודא זאת בזמן טעינה ולדחות נתיב חורג.
- `prompt` הוא הטקסט **הסופי המלא**. שים לב: היום ב-`src/lib/seed.ts` הפרומט
  נבנה על ידי פונקציית העזר `personaPrompt()`. בהמרה ל-JSON צריך להריץ אותה
  ולהדביק את **התוצר**, לא את המבנה.

### 3.2 סכימת JSON של סוג פגישה

```json
{
  "id": "kickoff",
  "title": "שיחת התנעה לפרויקט",
  "shortDescription": "יישור ציפיות בין בעלי העניין וזיהוי סיכונים מוקדם.",
  "prompt": "זוהי שיחת התנעה (kickoff)...",
  "isBuiltIn": true
}
```

### 3.3 סכימת הגדרות ארגון (`org-settings.json`)

```json
{
  "organizationName": "משרד התחבורה",
  "description": "...",
  "constraints": "..."
}
```

### 3.4 מבנה ה-manifest (נוצר אוטומטית)

```json
{
  "version": 1,
  "generatedAt": "2026-07-30T12:00:00.000Z",
  "orgSettings": "org-settings.json",
  "personas": ["personas/infra-architect.json", "personas/cio.json"],
  "meetingTypes": ["meeting-types/kickoff.json"],
  "sharedFiles": ["files/org-strategy.md"]
}
```

---

## 4. מה קורה לכל קובץ בקוד

### נמחק לגמרי

- `src/app/api/**` — כל ה-routes. אין יותר צד שרת.
- `src/lib/seed.ts` — התוכן שלו עובר לקבצי ה-JSON תחת `public/seed/`.

### נכתב מחדש

| קובץ | מה משתנה |
|---|---|
| `src/lib/store.ts` | מ-`fs` ל-**IndexedDB**. שמור על **אותן חתימות פונקציות בדיוק** — כולן כבר אסינכרוניות, ולכן `runner.ts` כמעט לא ישתנה. אפשר לזרוק את מנגנון נעילת הקבצים (`withFileLock`) ואת הכתיבה האטומית — IndexedDB מספק טרנזקציות. |
| `src/lib/extract.ts` | מספריות Node לספריות דפדפן. החתימה `extractText()` משתנה מ-`(filePath, ext)` ל-`(file: File \| Blob \| ArrayBuffer, ext)`. **התנהגות השגיאות נשארת זהה: לעולם לא זורק, מחזיר `{ text: '', error: '<הודעה בעברית>' }`.** |
| `src/lib/api-client.ts` | הופך ל-facade דק מעל `store.ts` במקום `fetch` ל-API. הפונקציה `runMeeting` קוראת ישירות למנוע במקום לצרוך SSE. אפשר גם למחוק אותו ולקרוא ל-store ישירות מהדפים — לשיקולך, אבל שמירה על ה-facade תשאיר את הדפים כמעט ללא שינוי. |

### נשאר כמעט ללא שינוי

- `src/lib/engine/**` — `runner.ts` צריך רק להחליף `randomUUID()` מ-`crypto` של
  Node ל-`crypto.randomUUID()` הגלובלי. `prompts.ts`, `schemas.ts`, `budget.ts`,
  `types.ts` — ללא שינוי.
- `src/lib/anthropic.ts` / `src/lib/gemini.ts` — להוסיף `dangerouslyAllowBrowser`
  ל-Anthropic, ולהסיר את קריאת `process.env` (בדפדפן אין env; המפתח מגיע תמיד
  מ-`opts.apiKey`). הודעת השגיאה בעברית כשאין מפתח — להתאים ל"הזן מפתח בהגדרות".
- `src/lib/llm.ts`, `src/lib/llm-types.ts`, `src/lib/types.ts` — ללא שינוי.
- `src/lib/api-key.ts` — ללא שינוי, כבר עובד מול `localStorage`.
- `src/components/**` — ללא שינוי.

### נוסף

| קובץ | תפקיד |
|---|---|
| `src/lib/seed-loader.ts` | טוען את ה-manifest, מביא את כל קבצי ה-seed, מחלץ טקסט מקבצי הרקע, וכותב ל-IndexedDB. |
| `src/lib/persona-io.ts` | ייצוא/ייבוא של פרסונה ל-JSON וממנו, כולל ולידציה ב-zod. |
| `src/lib/export.ts` | ה-Markdown renderer שעובר מ-`src/app/api/meetings/[id]/export/render.ts` (העבר את הקובץ כמעט as-is), בתוספת פונקציית הורדה בדפדפן. |
| `src/lib/base-path.ts` | ה-helper `seedUrl()`. |
| `scripts/build-seed-manifest.mjs` | סורק את `public/seed/` ומייצר `manifest.json`. |
| `.github/workflows/deploy-pages.yml` | בנייה ופריסה ל-GitHub Pages. |

---

## 5. פירוט מימוש

### 5.1 שכבת האחסון (IndexedDB)

התקן `idb` (עטיפה קטנה ומבוססת Promise ל-IndexedDB):

```bash
npm install idb
```

**מבנה מסד הנתונים:**

```
DB: "virmeet", version 1
  object store "personas"      keyPath: "id"
  object store "meetingTypes"  keyPath: "id"
  object store "meetings"      keyPath: "id"
  object store "kv"            keyPath: "key"   ← orgSettings + seedVersion
```

**חובה לשמור על החתימות הקיימות ב-`store.ts`** כדי ש-`runner.ts` ימשיך לעבוד:

```
listPersonas() / getPersona(id) / createPersona(input) /
updatePersona(id, patch) / deletePersona(id) / setPersonaFiles(id, files)

listMeetingTypes() / getMeetingType(id) / createMeetingType(input) /
updateMeetingType(id, patch) / deleteMeetingType(id)

getOrgSettings() / updateOrgSettings(patch)

listMeetings(summaryOnly?) / getMeeting(id) / createMeeting(input) /
updateMeeting(id, patch) / setMeetingFiles(id, files) / deleteMeeting(id)
```

**מה נשמר במקום העלאות לדיסק:** `saveUpload()` מוחלף בפונקציה שמקבלת `File`
מהדפדפן, מריצה `extractText()`, ומחזירה `AttachedFile`. השדה `storedPath` מאבד
את משמעותו — השאר אותו כמחרוזת ריקה, או השתמש בו לנתיב ה-seed כשהקובץ הגיע
משם (שימושי לדיבוג). **מגבלות הגודל (10MB) וסוגי הקבצים המותרים נשארות זהות.**

הערה: הפונקציות `deleteMeetingType` (שזורקת על מובנה) ו-`sanitizeFilename`
צריכות לעבור כמו שהן — הלוגיקה שלהן לא תלויה במערכת הקבצים.

### 5.2 טעינת ה-seed

לוגיקת הכניסה הראשונה, ב-`src/lib/seed-loader.ts`:

```
1. קרא kv["seedVersion"] מ-IndexedDB.
2. אם הוא שווה ל-manifest.version הנוכחי → אל תעשה כלום. סיים.
3. אחרת:
   a. fetch(seedUrl('seed/manifest.json'))
   b. לכל נתיב ב-personas[]: fetch, ולידציה ב-zod, המרה ל-Persona
   c. לכל נתיב ב-files[] של הפרסונה: fetch את הקובץ, חלץ טקסט, בנה AttachedFile
   d. לכל פריט ב-embeddedFiles[]: בנה AttachedFile ישירות מהטקסט
   e. upsert לפי id — אם פרסונה עם אותו id כבר קיימת, אל תדרוס אותה
      אלא אם המשתמש ביקש זאת במפורש (ראה "טעינה מחדש" למטה)
   f. אותו דבר ל-meetingTypes ול-orgSettings
   g. כתוב kv["seedVersion"] = manifest.version
```

**הכלל הקריטי:** טעינת seed אוטומטית **לעולם לא דורסת** נתונים שהמשתמש ערך.
היא רק מוסיפה מה שחסר. אחרת עריכה של פרסונה תימחק בכל רענון.

**"טען מחדש מהריפו"** — כפתור מפורש במסך ההגדרות שמריץ את אותו תהליך **עם**
דריסה, אחרי דיאלוג אישור (`ConfirmDialog` כבר קיים ב-`src/components/`).
ההודעה חייבת לומר בבירור שעריכות מקומיות לפרסונות הבסיס יאבדו.

**טיפול בשגיאות:** אם `manifest.json` לא נמצא או פגום — האפליקציה חייבת לעלות
בכל זאת, עם מסד ריק ובאנר אזהרה. אל תיתן לכשל טעינת seed להפיל את האתר.

### 5.3 ייצוא וייבוא של פרסונה

**ייצוא** (כפתור בעמוד עריכת פרסונה, וגם ברשימה):
- בנה אובייקט בסכימה מסעיף 3.1.
- קבצים שיש להם מקור seed → לשדה `files` (נתיבים).
- קבצים שהועלו בדפדפן → לשדה `embeddedFiles` (שם + טקסט מחולץ).
- הורד כ-`<persona-id>.json` עם `Blob` + `URL.createObjectURL` + עוגן.
  **שחרר את ה-URL עם `URL.revokeObjectURL` אחרי ההורדה.**

**ייבוא** (כפתור ברשימת הפרסונות, עם `<input type="file" accept=".json">`):
- ולידציה מלאה ב-**zod** לפני כתיבה. הודעות שגיאה בעברית בלבד.
- אם ה-`id` כבר קיים → הצג דיאלוג: "לדרוס את הפרסונה הקיימת?" / "לייבא כעותק
  חדש?" (עותק חדש = `id` חדש + הוספת סיומת לשם).
- אם ה-JSON מפנה ל-`files` שלא קיימים בריפו → אל תיכשל. ייבא את הפרסונה, סמן
  את הקובץ עם `extractionError` בעברית, והצג אזהרה למשתמש.
- תמוך גם בייבוא **מערך** של פרסונות מקובץ אחד (`Persona[]`), לא רק אובייקט
  יחיד — נוח לגיבוי מרוכז.

### 5.4 חילוץ טקסט בדפדפן

```bash
npm install pdfjs-dist
npm uninstall pdf-parse
```

`mammoth` כבר מותקן ויש לו build לדפדפן. **אמת את נתיב הייבוא הנכון** —
ככל הנראה `mammoth/mammoth.browser` — והשתמש ב-`extractRawText({ arrayBuffer })`.

ל-pdf.js צריך worker. שתי דרכים, נסה את הראשונה:
1. ייבוא ה-worker כ-URL דרך ה-bundler:
   `import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'` ואז
   `GlobalWorkerOptions.workerSrc = workerSrc`.
2. אם זה לא עובד בייצוא סטטי — העתק את קובץ ה-worker ל-`public/` בסקריפט
   prebuild והצבע עליו עם `seedUrl()`.

השאר את `MAX_CHARS = 60_000` ואת הערת הקיצוץ `'\n\n[הקובץ קוצץ]'` בדיוק כפי
שהם — הפרומטים מסתמכים על ההתנהגות הזו.

### 5.5 הרצת הפגישה בדפדפן

זה החלק שנעשה **פשוט יותר**, לא מסובך יותר. במקום SSE מהשרת, `runMeeting()`
מהמנוע נקראת ישירות מהדף ומקבלת callback:

```ts
await runMeeting(meetingId, (event) => {
  // אותם אירועים בדיוק: phase | entry | done | error
}, {}, { anthropic: getStoredApiKey('anthropic'), gemini: getStoredApiKey('gemini') });
```

חוזה האירועים לא משתנה, ולכן קוד ה-UI ב-`/meetings/view` נשאר כמעט זהה.

**שתי מגבלות חדשות שצריך לטפל בהן ב-UI:**
1. אם המשתמש עוזב את הדף באמצע ריצה — הריצה נעצרת. הוסף
   `beforeunload` warning בזמן `status === 'running'`.
2. פגישה שנקטעה תישאר תקועה ב-`status: 'running'` ב-IndexedDB. הוסף כפתור
   "סמן כבוטלה" בעמוד הפגישה כדי שאפשר יהיה לשחרר אותה.

### 5.6 קונפיגורציית Next

```ts
// next.config.ts
const nextConfig: NextConfig = {
  output: 'export',
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || '',
  images: { unoptimized: true },
  trailingSlash: true,
  eslint: { ignoreDuringBuilds: true },
};
```

- **הסר** את `serverExternalPackages` — הוא רלוונטי רק לצד שרת.
- `trailingSlash: true` מייצר `personas/edit/index.html`, מה ש-GitHub Pages
  מגיש נכון.
- ה-helper: `seedUrl(p)` מחזיר `${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/${p}`.

### 5.7 סקריפט ה-manifest

`scripts/build-seed-manifest.mjs`:
- סורק את `public/seed/personas/`, `public/seed/meeting-types/`, `public/seed/files/`.
- מדלג על `README.md` ועל קבצים שלא `.json` בשתי התיקיות הראשונות.
- מוודא שכל JSON נפרס בהצלחה — אם קובץ פגום, **הבנייה נכשלת עם הודעה ברורה
  שמציינת את שם הקובץ**. עדיף להיכשל בבנייה מאשר לפרוס אתר שבור.
- `version` — השתמש בחותמת זמן או ב-hash של תוכן כל הקבצים, כדי שכל שינוי
  בריפו יגרום לטעינה מחדש אצל משתמשים קיימים.

ב-`package.json`:

```json
"scripts": {
  "predev": "node scripts/build-seed-manifest.mjs",
  "prebuild": "node scripts/build-seed-manifest.mjs",
  "dev": "next dev",
  "build": "next build",
  "typecheck": "tsc --noEmit"
}
```

הוסף `public/seed/manifest.json` ל-`.gitignore`.

### 5.8 GitHub Actions

`.github/workflows/deploy-pages.yml` — טריגר על push ל-`main`, הרשאות
`pages: write` ו-`id-token: write`, ואז: checkout → setup-node 20 → `npm ci` →
`npm run build` עם `NEXT_PUBLIC_BASE_PATH=/Virmeet` → `actions/upload-pages-artifact`
מתיקיית `out/` → `actions/deploy-pages`.

**אל תשכח `public/.nojekyll`.** בלעדיו GitHub Pages מתעלם מתיקיות שמתחילות
בקו תחתון, ותיקיית `_next` — כלומר כל ה-JS וה-CSS — לא תוגש. האתר ייראה כמו
HTML ערום.

בהגדרות הריפו: **Settings → Pages → Source: GitHub Actions**.

---

## 6. רשימת משימות לביצוע

בצע לפי הסדר. הסדר נבחר כך שאפשר להריץ `npm run typecheck` אחרי כל שלב.

**שלב א — תשתית**
- [ ] צור ענף, תייג `pre-static-rewrite`
- [ ] `npm install idb pdfjs-dist` ; `npm uninstall pdf-parse`
- [ ] `src/lib/base-path.ts` עם `seedUrl()`
- [ ] עדכן `next.config.ts` (סעיף 5.6)
- [ ] צור `public/.nojekyll`

**שלב ב — תוכן ה-seed**
- [ ] המר את 4 הפרסונות מ-`src/lib/seed.ts` לקבצי JSON עם `id` יציב
      (זכור: הרץ את `personaPrompt()` והדבק את הפלט)
- [ ] המר את 5 סוגי הפגישות ל-JSON
- [ ] המר את הגדרות הארגון ל-`org-settings.json`
- [ ] `public/seed/files/README.md` — הסבר בעברית איך מוסיפים קובץ ומשייכים אותו
- [ ] `scripts/build-seed-manifest.mjs` + עדכון `package.json`
- [ ] מחק את `src/lib/seed.ts`

**שלב ג — אחסון וחילוץ**
- [ ] כתוב מחדש את `src/lib/store.ts` מול IndexedDB, באותן חתימות
- [ ] כתוב מחדש את `src/lib/extract.ts` לדפדפן (pdf.js + mammoth browser)
- [ ] `src/lib/seed-loader.ts` עם לוגיקת ה-upsert מסעיף 5.2

**שלב ד — ניתוק צד השרת**
- [ ] מחק את `src/app/api/**`
- [ ] העבר את `render.ts` ל-`src/lib/export.ts` + הוסף הורדת Blob
- [ ] עדכן את `src/lib/anthropic.ts` (`dangerouslyAllowBrowser`, בלי `process.env`)
- [ ] עדכן את `src/lib/gemini.ts` (בלי `process.env`)
- [ ] `randomUUID()` → `crypto.randomUUID()` ב-`runner.ts`
- [ ] כתוב מחדש את `src/lib/api-client.ts` כ-facade מעל ה-store

**שלב ה — ניתוב ו-UI**
- [ ] `/personas/[id]` → `/personas/edit/?id=` (עם `<Suspense>`)
- [ ] `/meetings/[id]` → `/meetings/view/?id=` (עם `<Suspense>`)
- [ ] עדכן כל `router.push` / `<a href>` / `<Link>` שמפנה לנתיבים הישנים
- [ ] הרצת פגישה ישירות מהדפדפן + אזהרת `beforeunload` + כפתור "סמן כבוטלה"
- [ ] `src/lib/persona-io.ts` + כפתורי ייצוא/ייבוא
- [ ] כפתור "טען מחדש מהריפו" בהגדרות, עם `ConfirmDialog`
- [ ] הסר את בדיקת `/api/health` ממסך פגישה חדשה — עכשיו בודקים רק
      `localStorage` (אין יותר מפתח שרת)

**שלב ו — פריסה ותיעוד**
- [ ] `.github/workflows/deploy-pages.yml`
- [ ] עדכן `README.md`: כתובת האתר, הסבר על `public/seed/`, איך מוסיפים פרסונה
      דרך GitHub, והבהרה שהמפתח נשלח מהדפדפן ישירות לספק
- [ ] הפעל Pages בהגדרות הריפו ואמת שהאתר החי עולה

---

## 7. קריטריוני קבלה

בדוק את כולם **על האתר החי**, לא רק מקומית — חלק מהבאגים (basePath, CORS,
`.nojekyll`) מופיעים רק שם.

1. `npm run build` מסתיים בהצלחה ומייצר `out/` עם `index.html`.
2. `npm run typecheck` נקי.
3. באתר החי, בכניסה ראשונה בדפדפן נקי: 4 פרסונות ו-5 סוגי פגישות מופיעים.
4. עריכת פרסונה נשמרת ושורדת רענון.
5. עריכת פרסונת בסיס **לא נדרסת** ברענון.
6. ייצוא פרסונה מוריד JSON תקין; ייבוא של אותו קובץ בדפדפן אחר משחזר אותה במלואה.
7. הוספת קובץ ל-`public/seed/files/` + הפניה אליו מ-JSON של פרסונה → אחרי
   push וסיום ה-Action, הקובץ מופיע אצל הפרסונה עם טקסט מחולץ.
8. **פגישה מלאה רצה מקצה לקצה** עם מפתח Anthropic אמיתי ומייצרת משימות.
9. אותו דבר עם פרסונה שמוגדרת למודל Gemini.
10. העלאת PDF ו-DOCX בדפדפן מחלצת טקסט; קובץ פגום מציג שגיאה בעברית ולא מפיל כלום.
11. ייצוא הפגישה ל-Markdown מוריד קובץ עם שורת ההסתייגות בראשו.
12. רענון קשה (Ctrl+Shift+R) על `/personas/edit/?id=...` נטען ולא מחזיר 404.

---

## 8. מה זה לא סוגר

תעד את אלה ב-README כדי שהציפיות יהיו נכונות:

- **הנתונים חיים בדפדפן בלבד.** החלפת מחשב, החלפת דפדפן, או ניקוי נתוני אתר —
  והכל נעלם. הייצוא ל-JSON הוא מנגנון הגיבוי היחיד. שקול להוסיף בעתיד
  "ייצוא הכל" שמוריד את כל הפרסונות בקובץ אחד.
- **המפתח חשוף בדפדפן.** זה מודל האמון של כלי אישי.
- **הריצה קשורה ללשונית פתוחה.** סגירה באמצע = פגישה קטועה.
- **אין שיתוף בין משתמשים.** שני אנשים שגולשים לאותו URL לא רואים אותם נתונים.

## 9. הדרך חזרה ל-Vercel

הגרסה הסטטית **לא סוגרת** את הדלת:

- אפשר לפרוס את אותו build הסטטי ל-Vercel כמו שהוא, בלי שינוי.
- אם ירצו את גרסת השרת בחזרה — היא שמורה בתג `pre-static-rewrite`.
- אם ירצו בעתיד אחסון משותף בצד שרת: כיוון ש-`store.ts` שומר על אותן חתימות
  פונקציות, אפשר להחליף את המימוש שלו במימוש שקורא ל-API בלי לגעת ב-`runner.ts`
  או בדפים. זו הסיבה שסעיף 5.1 מתעקש על שמירת החתימות.
