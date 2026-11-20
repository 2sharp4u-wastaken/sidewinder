# Sidewinder

משחק סנייק במדבר בלילה: 7 לוחות בסגנון נוקיה, מהירויות 1–9, שבעה בונוסים שמצטברים, חיפושית בונוס וקומבו. עובד במחשב (מקשי חצים / WASD) ובטלפון ובטאבלט (החלקה או כפתורי חצים), ואפשר להוסיף אותו למסך הבית.

## לוח שיאים משפחתי

- בלי לוח משפחתי, השיא נשמר רק במכשיר.
- **יצירת לוח**: בתפריט הראשי לוחצים על "Family leaderboard" ואז "Create a family board". המשפחה מקבלת קוד אקראי בן 8 תווים.
- **מכשיר נוסף**: "Add a device" שולח קישור בצורה `/?family=CODE`. אפשר גם להקליד את הקוד במכשיר השני.
- **שחקנים וקוד סודי (PIN)**: לכל שחקן יש קוד בן 4 ספרות. בכל מכשיר מקישים אותו פעם אחת ("Who's playing"), ומאז המכשיר משחק בשמו בלי לשאול שוב. בלי הקוד אי אפשר לשחק בשם של מישהו אחר, לשנות לו את הקוד או למחוק אותו. השרת בודק את זה, לא רק המסך.
- **שינוי קוד** ("Change PIN") מנתק את כל המכשירים האחרים של אותו שחקן, והם צריכים את הקוד החדש. אחרי 6 קודים שגויים השחקן ננעל ל-15 דקות.
- שחקן שנוצר לפני שהיו קודים (נובמבר 2026): הקוד הראשון שמקישים עבורו הופך לקוד שלו.
- **ספירת משחקים**: כל משחק שנגמר נספר לפי לוח ולפי מהירות פתיחה (1–9). הטבלה נמצאת במסך Family board, מתחת לשיאים.
- השיא של כל שחקן בכל לוח נשמר בשרת, כך שאותו שחקן רואה את אותם שיאים בכל מכשיר.
- עד 12 שחקנים למשפחה. נשמרים רק שם, צבע, קוד מוצפן (hash), השיא לכל לוח (ניקוד, מהירות, שלב, אורך ותאריך) ומספר המשחקים לכל לוח ומהירות.
- משחק שנגמר בלי אינטרנט נשמר במכשיר ועולה לשרת כשהחיבור חוזר.

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
| `GET /api/f/:code/players` | השחקנים, השיאים (`b`) ומספר המשחקים לפי לוח ומהירות (`g`) |
| `PUT /api/f/:code/players/:id` | יצירת שחקן `{ name, colour, pin }` ומחזיר `{ token }` |
| `POST /api/f/:code/players/:id/unlock` | `{ pin }` ומחזיר `{ token }` למכשיר הזה |
| `POST /api/f/:code/players/:id/games` 🔑 | `{ board, speed, score, level, len }`: סופר משחק ושומר אם זה שיא |
| `POST /api/f/:code/players/:id/pin` 🔑 | `{ pin }`: קוד חדש, ומנתק את שאר המכשירים |
| `DELETE /api/f/:code/players/:id` 🔑 | מוחק שחקן, שיאים, משחקים ומכשירים |

🔑 = דורש `Authorization: Bearer <token>`.

## פרסום (Cloudflare Workers, חינם)

1. dash.cloudflare.com ← Workers & Pages ← Create ← Workers ← **Connect to Git** ← המאגר `sidewinder`.
2. Framework preset: **None**. Build command: ריק. Deploy command: `npx wrangler deploy`.
3. בפריסה הראשונה Wrangler יוצר לבד את מסד הנתונים `sidewinder-db`, והטבלאות נוצרות בבקשה הראשונה.

הכתובת: https://sidewinder.2sharp4u.workers.dev

**אם דחיפה ל-`main` לא מפעילה בנייה** (קרה בנובמבר 2026, כנראה כי לאפליקציית Cloudflare ב-GitHub אין גישה לריפו): ב-Cloudflare, sidewinder ← Settings ← Deploy Hooks יש hook בשם `claude-deploy` שבונה את `main`. בקשת POST לכתובת שלו מפעילה בנייה. התיקון הקבוע: ב-GitHub, Settings ← Applications ← Cloudflare Workers and Pages ← Configure, ולהוסיף את `sidewinder`.

## פיתוח מקומי

```sh
npm install
npx wrangler dev        # http://localhost:8787
```
