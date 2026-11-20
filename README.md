# Sidewinder

משחק סנייק במדבר בלילה: 7 לוחות בסגנון נוקיה, מהירויות 1–9, שבעה בונוסים שמצטברים, חיפושית בונוס וקומבו. עובד במחשב (מקשי חצים / WASD) ובטלפון ובטאבלט (החלקה או כפתורי חצים), ואפשר להוסיף אותו למסך הבית.

## לוח שיאים משפחתי

- בלי לוח משפחתי, השיא נשמר רק במכשיר.
- **יצירת לוח**: בתפריט הראשי לוחצים על "Family leaderboard" ואז "Create a family board". המשפחה מקבלת קוד אקראי בן 8 תווים.
- **מכשיר נוסף**: "Add a device" שולח קישור בצורה `/?family=CODE`. אפשר גם להקליד את הקוד במכשיר השני.
- **שחקנים**: כל אחד בוחר את השם שלו פעם אחת במכשיר ("Who's playing"). השיא של כל שחקן בכל לוח נשמר בשרת, כך שאותו שחקן רואה את אותם שיאים בכל מכשיר.
- עד 12 שחקנים למשפחה. נשמרים רק שם, צבע והשיא לכל לוח (ניקוד, מהירות, שלב, אורך ותאריך).
- שיא שנעשה בלי אינטרנט נשמר במכשיר ועולה לשרת כשהחיבור חוזר.

## מבנה

```
public/index.html  המשחק (קובץ אחד: HTML, CSS ו-JS)
public/sw.js       service worker: רשת קודם, עותק אחרון למשחק בלי אינטרנט
worker/index.js    ה-API של הלוח המשפחתי (Cloudflare Worker + D1)
wrangler.jsonc     הגדרות Cloudflare
```

המקור הוא ה-Artifact ב-Claude. ההבדלים: אין `window.claude`, יש לוח משפחתי, manifest, אייקונים ו-service worker.

### API

| בקשה | מה עושה |
|---|---|
| `POST /api/families` | יוצר משפחה ומחזיר `{ code }` (עד 10 בשעה לכל IP) |
| `GET /api/f/:code/players` | השחקנים והשיאים שלהם |
| `PUT /api/f/:code/players/:id` | יצירה או שינוי שם `{ name, colour }` |
| `POST /api/f/:code/players/:id/scores` | `{ board, score, speed, level, len }`. השרת שומר רק אם זה שיא |
| `DELETE /api/f/:code/players/:id` | מוחק שחקן ואת השיאים שלו |

## פרסום (Cloudflare Workers, חינם)

1. dash.cloudflare.com ← Workers & Pages ← Create ← Workers ← **Connect to Git** ← המאגר `sidewinder`.
2. Framework preset: **None**. Build command: ריק. Deploy command: `npx wrangler deploy`.
3. בפריסה הראשונה Wrangler יוצר לבד את מסד הנתונים `sidewinder-db`, והטבלאות נוצרות בבקשה הראשונה.

מכאן כל דחיפה ל-`main` מתפרסמת אוטומטית ל-`sidewinder.<account>.workers.dev`.

## פיתוח מקומי

```sh
npm install
npx wrangler dev        # http://localhost:8787
```
