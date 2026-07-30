# תכנון: תיקוני נכונות ותשתית הערכה

מסמך ביצוע. **אומת מול `89d507b`** (main אחרי מיזוג PR #4) — כלומר מול הארכיטקטורה
הסטטית, רב-הספק, שבה כל הריצה קורית בדפדפן. כל טענה כאן נבדקה בקוד, וההפניות
מדויקות לגרסה הזו.

---

## 0. הוראות למי שמבצע

1. עבוד לפי הסדר. שלב 1 מייצר את תשתית הבדיקות ששאר השלבים נשענים עליה.
2. **קומיט נפרד לכל סעיף ממוספר.** אל תאחד.
3. אחרי כל סעיף: `npm run typecheck && npm test`. בסוף כל שלב גם `npm run build`.
4. אם סעיף מתגלה כשגוי — **עצור ודווח**, אל תמציא תחליף.
5. ההחלטות הפתוחות בסעיף 6 דורשות אישור לפני מימוש. אל תנחש.

### מה כבר תפוס — אל תיגע

`docs/PLAN-file-context-optimization.md` מכסה את כל תחום ניהול ההקשר של הקבצים:
שלב 1 (cache) כבר מומש ב-PR #4, ושלבים 2 (תמציות) ו-3 (כלי קריאה) מתוכננים שם
בפירוט. **אל תתכנן ואל תבצע כאן שום דבר בתחום הזה.** אם עולה רעיון על קבצים, מטמון
או הקשר — מקומו במסמך ההוא.

### אינווריאנטות שאסור לשבור

- **בידוד שלב `prep`** (`runner.ts:173-192`) — כל פרסונה קוראת בנפרד ובמקביל בלי לראות
  פלט של אחרות. זה המנגנון המרכזי של הכלי, וה-README מזהיר עליו במפורש.
- **מזהי המודלים** ב-`types.ts:3-13` — בלי סיומות תאריך.
- **אין שרת.** `output: "export"` ב-`next.config.ts`. אסור להוסיף route handlers, אסור
  להסתמך על `process.env` בזמן ריצה, ואסור לייבא מודולי Node לצד הלקוח (ראה רשימת
  ה-fallbacks ב-`next.config.ts`).
- **מפתחות API** לא נכנסים ל-`transcript`, ל-patch שנשמר, או ללוגים (`runner.ts:81-85`).
- **חוזה `CallModelOptions`/`CallModelResult`** (`llm-types.ts`) משותף לשני הספקים.
  שינוי בו = שינוי ב-`anthropic.ts` **וגם** ב-`gemini.ts`. אין ספק אחד.
- מחרוזות למשתמש בעברית, הערות קוד באנגלית.

---

## 1. תשתית בדיקות (vitest)

אין כרגע אף בדיקה בריפו. `api-key-test.ts` הוא מודול אימות מפתחות, לא בדיקה.

**שינויים:**

- `package.json`: devDependency `vitest`; scripts `"test": "vitest run"`,
  `"test:watch": "vitest"`.
- `vitest.config.ts` בשורש: `environment: 'node'`, `include: ['src/**/*.test.ts']`,
  ו-`resolve.alias` של `'@' → ./src` (חובה — `tsconfig.json` מגדיר את ה-alias).
- ייבא `describe/it/expect/vi` במפורש מ-`vitest`. **אל** תפעיל `globals: true` — זה
  יחייב שינוי ב-`tsconfig.json`, ו-`include` שם כבר תופס `**/*.ts`.
- `src/lib/engine/__tests__/helpers.ts`: `makePersona/makeMeeting/makeOrg/makeMeetingType`,
  ו-`makeDeps()` שמחזיר `RunMeetingDeps` מלא. `updateMeeting` שם חייב לצבור את
  ה-patches למערך **ולהחזיר את המצב המצטבר** — הריצה האמיתית מסתמכת על כך.
  `scriptedCallModel(responses)` — stub שסופר קריאות ומחזיר `CallModelResult` מלא.

**שים לב:** `runner.ts:59` משתמש ב-`crypto.randomUUID()` הגלובלי (לא `node:crypto`).
זמין ב-Node 19+; אם סביבת הבדיקה לא מספקת אותו, הוסף polyfill ב-setup file ולא
בקוד המקור.

**קריטריון קבלה:** `npm test` עובר עם `src/lib/engine/budget.test.ts` — ארבע בדיקות
ל-`CallBudget`: `canCall` לפני ומיצוי אחרי, `record` מצטבר, ו-`shouldAnnounceExhausted`
מחזיר `true` בדיוק פעם אחת.

---

## 2. ביטול פגישה לא מבטל — באג מאומת

### הראיה

ההערה ב-`api-client.ts:302-307` אומרת את זה במפורש:

> `signal` — when aborted — **stops delivering events to the UI, but ... does not
> stop the run itself**: it keeps going and keeps persisting to IndexedDB.

ובפועל: `handleCancel` (`view/page.tsx:458-467`) עושה `abortRef.current?.abort()`,
שכל תפקידו הוא להדליק את הדגל `aborted` ב-`api-client.ts:340-342` ולחסום העברת
אירועים ל-UI. המנוע עצמו ממשיך: `runner.ts` **לא מזכיר `cancel` אפילו פעם אחת**,
`emitPhase` כותב `status:'running'` בכל מעבר שלב (`runner.ts:147-150`), ובסוף
`persist({status:'completed', ...})` (`runner.ts:459`).

### למה זה חמור יותר מבעבר

בארכיטקטורה הישנה זה בזבז מפתח שרת. עכשיו הריצה קורית בדפדפן של המשתמש ומול
**המפתח האישי שלו** — כלומר לחיצה על "בטל" מסתירה את הריצה מהעין אבל ממשיכה לחייב
אותו, והפגישה חוזרת ומופיעה כ-`running` ואז כ-`completed` אחרי שהוא ביטל אותה.

### התיקון — קל יותר מבעבר

אין יותר שרת, והמנוע רץ באותו טאב שבו נמצא ה-`AbortController`. לכן אפשר להעביר
`AbortSignal` ישירות למנוע, בלי סקרים ובלי קריאות אחסון חוזרות:

1. `engine/types.ts` — הוסף `signal?: AbortSignal` לחתימת `runMeeting`, והוסף
   `| { type: 'cancelled' }` ל-`MeetingEvent`.
2. `runner.ts`:
   - `function isAborted(): boolean` → `signal?.aborted === true`.
   - `persist()` — כשהריצה בוטלה, **הסר** `status` ו-`completedAt` מה-patch.
     `transcript` ו-`usage` כן נשמרים: רוצים לשמר את מה שכבר נאמר ואת מה שכבר שולם עליו.
   - `abortIfCancelled(phase, round?)` — מוסיף שורת מערכת
     (`"הפגישה בוטלה על ידי המשתמש. הדיון נעצר."`), כותב `{status:'cancelled'}`
     **ישירות דרך `deps.updateMeeting`** (לא דרך `persist`, שמסנן `status`), משדר
     `{type:'cancelled'}` ומחזיר `true`.
   - נקודות בדיקה: לפני `persist({status:'running'})` הראשון (שורה 165); לפני כל
     `emitPhase`; אחרי ש-`Promise.allSettled` של prep מסתיים; ובלולאת הדיון **לפני
     כל תור** (שורה 306).
3. `api-client.ts` — העבר את `handlers.signal` הלאה ל-`engineRunMeeting`, והוסף
   `case 'cancelled'` ב-switch. השאר את דגל `aborted` הקיים; הוא עדיין נכון עבור
   אירועים שכבר בדרך.
4. `view/page.tsx` — חבר `onCancelled` ל-`setStatus('cancelled')`, ודא ש-`PhaseRail`
   (שורה 83) לא מציג `cancelled` כאילו הוא רץ, והצג באנר.
5. **עדכן את ההערה ב-`api-client.ts:302-307`** — היא תהפוך לשקר אחרי השינוי, וזה
   בדיוק סוג הדבר שמטעה את הקורא הבא.

**קריטריוני קבלה (בדיקות):** signal שנקטע אחרי התור השני → `callModel` לא נקרא שוב;
אף patch שנכתב אחרי הביטול לא מכיל `'running'` או `'completed'`; התמליל שנצבר נשמר;
אירוע `cancelled` שודר בדיוק פעם אחת.

---

## 3. חיתוך ב-`max_tokens` נחשב לתשובה שלמה — בשני הספקים

### הראיה

`CallModelResult` (`llm-types.ts:44-49`) לא מכיל שום שדה על חיתוך, ואף ספק לא בודק זאת:

- **Anthropic** — `extractResult` (`anthropic.ts`, סביב שורה 88) בודק רק
  `stop_reason === 'refusal'`. `'max_tokens'` עובר כאילו כלום.
- **Gemini** — `BLOCKED_FINISH_REASONS` (`gemini.ts:79`) מכיל חמישה טעמי חסימה,
  ו-`MAX_TOKENS` **אינו** ביניהם. תשובה קטועה חוזרת עם `refused:false` וטקסט חלקי
  (`gemini.ts:112-125`).

כל הקריאות רצות עם `REGULAR_MAX_TOKENS = 8000` (`runner.ts:40`), ושני הספקים סופרים
טוקני חשיבה מתוך אותו תקציב — Anthropic עם `thinking:{type:'adaptive'}` ו-Gemini עם
`thinkingConfig` (`gemini.ts:92`). קריאת ה-extraction רצה עם `effort:'high'` וצריכה
לפלוט את כל `EXTRACTION_SCHEMA`. זה תרחיש סביר.

### מה קורה היום כשזה קורה

| שלב | ההתנהגות |
|---|---|
| `prep` | JSON קטוע → `JSON.parse` זורק (`runner.ts:217`) → הפרסונה נעלמת עם "פלט לא תקין (JSON)" |
| `discussion` | טקסט חתוך באמצע משפט נכנס לתמליל **כאילו זו אמירה שלמה**. אין שום סימן |
| `extraction` | כל הפגישה `failed` עם `"Unexpected end of JSON input"` |

**מקרה קצה נוסף ב-Gemini:** אם החשיבה בולעת את כל התקציב, `response.text` יכול לחזור
ריק, ואז `gemini.ts:121` מחזיר `text: ''` עם `refused:false` — ו-`JSON.parse('')` זורק.
אותה תסמונת, סיבה שונה.

### התיקון

1. `llm-types.ts` — הוסף `truncated: boolean` ל-`CallModelResult`.
2. `anthropic.ts` — `truncated: message.stop_reason === 'max_tokens'`. שמור על סדר
   הבדיקות: `refusal` נבדק ראשון ומחזיר מיד (עם `truncated:false`).
3. `gemini.ts` — `truncated: finishReason === 'MAX_TOKENS'`. הוסף גם טיפול מפורש
   בטקסט ריק שאינו חסימה.
4. `runner.ts`:
   - `prep` — בדוק `result.truncated` **לפני** `JSON.parse`; אם דלוק, שורת מערכת
     `"התשובה של {שם} נקטעה בשל מגבלת אורך ולכן לא נכללה בשלב ההכנה."` ו-`continue`.
   - `opening` — התייחס כמו לכישלון: מסגור בסיסי + שורת מערכת מפורשת.
   - `discussion` — כן פלוט את התמליל, אבל הוסף לסוף הטקסט
     `"\n\n[הערת מערכת: התגובה נקטעה בשל מגבלת אורך]"`. הקורא חייב לדעת.
   - `extraction` — זרוק שגיאה עברית ברורה במקום להשאיר את `JSON.parse` להיכשל.

### 3.1 העלאת תקציב הטוקנים לשלב החילוץ — **הוחלט, בצע**

שאר הקריאות נשארות על `REGULAR_MAX_TOKENS = 8000`. קריאת ה-`extraction` בלבד עוברת
לקבוע חדש:

```ts
// The extraction call is the only one that must emit the entire
// EXTRACTION_SCHEMA in one response, and it runs at effort:'high' — where
// thinking tokens come out of the same budget. A truncation here loses the
// whole meeting's output, so it gets its own, larger budget. The value is
// deliberately above anthropic.ts#STREAMING_THRESHOLD so the Anthropic path
// switches to streaming automatically.
const EXTRACTION_MAX_TOKENS = 20000;
```

**הנימוק:** זהו השלב היחיד שכישלון בו מאבד את כל תוצר הפגישה — התמליל נשמר, אבל
המשימות, ההחלטות והשאלות הפתוחות הולכות לאיבוד. ההתייקרות חלה על קריאה אחת בלבד
מתוך ~15 בפגישה טיפוסית, ומשולמת רק על טוקנים שנוצרו בפועל.

⚠️ **שתי נקודות לאמת בזמן המימוש:**
1. **Anthropic** — 20000 חוצה את `STREAMING_THRESHOLD` (16000, `anthropic.ts:29`) ולכן
   `callModel` יעבור אוטומטית ל-`messages.stream(...).finalMessage()`. זהו מסלול שלא
   נבדק עד היום בפרויקט. ודא שהוא מחזיר `stop_reason` תקין — סעיף 3 כולו נשען על כך.
2. **Gemini** — `gemini.ts` **לא מממש streaming בכלל**; הוא תמיד קורא ל-
   `generateContent`. שם 20000 רק מעלה את `maxOutputTokens`. ודא שהערך תקף למודל
   המנחה (`gemini-3.1-pro-preview`) ושאין timeout בצד הדפדפן על תשובה ארוכה.

אם מתברר ש-20000 אינו תקף לאחד הספקים — בחר את הערך התקף הגבוה ביותר, ועדכן את
ההערה בקוד כך שתשקף את הסיבה האמיתית לבחירה.

⚠️ **לאמת מול התיעוד לפני מימוש, לא מהזיכרון:** המחרוזת המדויקת של `finishReason`
ב-`@google/genai` v2 (enum או literal?), ושמסלול ה-streaming של Anthropic
(`STREAMING_THRESHOLD = 16000`, `anthropic.ts:29`) מחזיר `stop_reason` תקין דרך
`finalMessage()` אם מעלים את התקציב מעל הסף.

**קריטריוני קבלה:** שמונה בדיקות — ארבעה שלבים × שני ספקים — עם stub שמחזיר
`truncated:true`. ובמיוחד: `extraction` נכשל עם הודעה עברית קריאה, לא עם `SyntaxError`.

---

## 4. משתמש עם מפתח Gemini בלבד — כל הפרסונות נכשלות

### הראיה — באג חדש, לא היה בגרסה הקודמת

- ברירת המחדל של פרסונה היא `claude-sonnet-5` (`types.ts:4`), וכך גם כל ארבע
  פרסונות ה-seed תחת `public/seed/personas/`.
- `pickFacilitatorModel` (`types.ts:30-34`) פותר את זה **למנחה בלבד** — הוא נופל
  ל-Gemini כשאין מפתח Anthropic. **אף אחד לא עושה את זה לפרסונות.**
- `api-client.ts:311-320` בודק רק שקיים **מפתח אחד לפחות**, לא שהוא מתאים למודלים
  שהפגישה בפועל תשתמש בהם.
- `apiKeyFor()` (`runner.ts:96-98`) יחזיר `undefined` לכל פרסונה על Claude,
  ו-`getClient` (`anthropic.ts:16-20`) יזרוק `"מפתח ה-API של Anthropic לא הוגדר"`.

### התוצאה

משתמש חדש שהזין מפתח Gemini בלבד ולא נגע בפרסונות מקבל: כל קריאות ה-`prep` נכשלות,
התמליל מורכב כולו משורות שגיאה, הדיון רץ על ריק, וה-extraction מפיק "תוצאות" מפגישה
שלא התקיימה. זה מסלול first-run סביר לחלוטין, והכשל בו רועש אבל חסר הסבר.

### התיקון

הוסף **בדיקה מקדימה ב-`api-client.ts#runMeeting`**, לפני `engineRunMeeting`: אסוף את
הספקים של כל מודלי המשתתפים (דרך `getModelProvider`) ושל `pickFacilitatorModel`,
והשווה מול המפתחות הקיימים. אם חסר מפתח לספק כלשהו — עצור עם הודעה שמונה **בשמות**
אילו משתתפים ידרשו מפתח שאין, ומה לעשות (להזין מפתח, או להחליף את מודל הפרסונה).

זו בדיקה שקטה, זולה, ורצה לפני שנשרפה ולו קריאה אחת.

**קריטריון קבלה:** בדיקה שמוודאת שפגישה עם פרסונות Claude ומפתח Gemini בלבד נעצרת
לפני הקריאה הראשונה, ושההודעה מכילה את שמות המשתתפים החסומים.

---

## 5. חיפוש רשת + פלט מובנה יחד ב-Gemini

**חשד, לא ממצא.** ב-`prep` הרנר מעביר גם `jsonSchema: PREP_SCHEMA` וגם `webSearch`
כשלפרסונה יש `webAccess` (`runner.ts:183-184`). ב-`gemini.ts:94-100` זה מתורגם
ל-`responseJsonSchema` **וגם** `tools: [{googleSearch:{}}]` באותה בקשה. לפי הידוע לי
זהו שילוב מוגבל ב-Gemini API — אבל **לא אימתתי, ואסור להניח.**

**מה לעשות:** ראשית בדוק מול התיעוד הרשמי. אם השילוב אכן נחסם — פרסונת Gemini עם
`webAccess: true` תיכשל בכל שלב `prep`, וצריך להחליט בין שתי קריאות (חופשית עם
חיפוש, ואז מובנית) לבין השבתת החיפוש בשלב `prep` בלבד ל-Gemini. שים לב ש-
`docs/PLAN-file-context-optimization.md` סעיף 6.3 כבר דן בדיוק בדפוס "שתי קריאות"
הזה עבור כלים — **התיישר איתו, אל תמציא דפוס מתחרה.**

אם מתברר שהשילוב עובד — סגור את הסעיף בשורה אחת ב-PR ואל תשנה קוד.

---

## 6. תשתית הערכה — האם הכלי בכלל עובד

**זה הסעיף החשוב ביותר במסמך.** ה-README מגדיר בעצמו את קריטריון ההצלחה — "הרץ
פגישה, ערבב את השורות, ובקש ממודל אחר לשייך כל אמירה לדובר. אם הוא לא עובר את רמת
הניחוש — הפרסונות פיקטיביות" — **ואף שורת קוד לא מממשת אותו.** בלי זה כל שינוי
בפרומט הוא ניחוש, ואי אפשר לענות על השאלה שהכלי כולו נשען עליה: האם הפרסונות באמת
נשמעות שונה, או שאלה עותקים של אותו מודל.

זה גם מה שיכריע אם שלבים 2-3 של `PLAN-file-context-optimization` בכלל משתלמים — אותו
מסמך דורש מדידת בסיס בסעיף 3 שלו, וזו התשתית שתספק אותה.

### 6.1 `src/lib/eval/attribution.ts`

- `buildAttributionInput(transcript, participants, seed)` — מסנן לשורות משלב
  `discussion` בלבד שה-`speakerId` שלהן שייך למשתתף (לא `'system'`, לא `'facilitator'`),
  ממספר אותן, ומערבב ב-RNG **מבוזרע** כדי שהרצות יהיו ניתנות לשחזור. מחזיר
  `{ items: {index, text}[], truth: Map<number, string> }`.
- `ATTRIBUTION_SCHEMA` — `{assignments: [{index: number, personaName: string}]}`, עם
  `additionalProperties:false` ו-`required` מלא, כמו כל סכימה אחרת (`schemas.ts:1-5`).
- `runAttributionTest(...)` — קריאת מודל אחת דרך `callModel` של `llm.ts` (כלומר עובד
  מול שני הספקים בחינם).

  **קריטי:** השופט מקבל **רק שמות ותפקידים**. אסור להעביר לו את `persona.prompt`, את
  הקבצים הפרטיים או את שלב ה-`prep` — אחרת המבחן מודד התאמת טקסט לפרומט, ולא את מה
  שאנחנו רוצים למדוד.

- `scoreAttribution(truth, guesses, participants)` — **פונקציה טהורה** שמחזירה
  `{ total, correct, accuracy, chance: 1/N, perPersona: {name, recall, precision}[], confusion }`.

### 6.2 איפה זה רץ

הנתונים חיים ב-IndexedDB של הדפדפן, לא על דיסק — כלומר סקריפט CLI **לא יכול לקרוא
פגישה ישירות**. זה הופך את ההמלצה הקודמת שלי ("CLI קודם") ללא רלוונטית. ראה החלטה
פתוחה 7.3.

### 6.3 מבחן הבנאליות (אופציונלי, רק אחרי ש-6.1 עובד)

ה-README: "אם הוא מייצר עשרים תובנות שכולן נכונות־אך־מובנות־מאליהן, זה מחולל טקסט
ולא כלי." אותו מבנה: קריאת מודל אחת שמסווגת כל פריט ב-`result.openQuestions` וב-
`result.risks` כ"ספציפי להקשר" מול "נכון לכל פרויקט מהסוג הזה", ומדווחת יחס. מספר
יחיד שאפשר לעקוב אחריו בין שינויי פרומט.

---

## 7. החלטות פתוחות — דורשות אישור לפני מימוש

1. **הרצה חוזרת של פגישה שבוטלה או שנתקעה.** `runner.ts:132` מאתחל
   `transcript = [...meeting.transcript]`, ו-`api-client.ts:326-334` חוסם רק `running`
   ו-`completed`. כלומר פגישה `cancelled` ניתנת להרצה חוזרת — אבל התמליל יצטבר על
   הישן וייווצרו שורות `prep` כפולות. זה רלוונטי גם לפגישה שנתקעה ב-`running` אחרי
   רענון טאב (מתועד ב-`view/page.tsx:421-426`, שם הביטול הוא דרך המילוט).
   אפשרויות: (א) לחסום; (ב) לאפס `transcript`+`usage` בהרצה חוזרת; (ג) להשאיר.
   **המלצה: (ב).**

2. **איפה מבחן הייחוס חי** (סעיף 6.2). שתי אפשרויות:
   (א) **בתוך האפליקציה** — כפתור במסך פגישה שהושלמה, מריץ בדפדפן עם המפתח הקיים
   ומציג דוח. מתאים לארכיטקטורה, אבל מוסיף משקל ל-bundle של המוצר;
   (ב) **מבוסס ייצוא** — `downloadMeetingJson` כבר קיים (`export.ts:138`), אז סקריפט
   `scripts/eval-attribution.mjs` יכול לקרוא קובץ מיוצא. שומר את הכלי מחוץ למוצר.
   **המלצה: (ב)** — ההערכה היא כלי פיתוח, לא פיצ'ר, ושמירתה מחוץ ל-bundle גם מונעת
   ממנה לגדול לתוך המוצר. אבל זו החלטה שלך.

---

## 8. אימות סופי

```bash
npm run typecheck
npm test
npm run build      # חייב לעבור עם output:"export" — כל route חדש ישבור אותו
```

ובדיקה ידנית שאף בדיקה אוטומטית לא מכסה: הרץ פגישה עם 2 פרסונות ו-2 סבבים, לחץ
"בטל" באמצע שלב הדיון, וּודא ב-DevTools → Application → IndexedDB שהסטטוס נשאר
`cancelled`, שהתמליל החלקי נשמר, ושבלשונית Network לא יוצאות קריאות נוספות לספק אחרי
הביטול.
