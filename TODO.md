# רשימת משימות

כל פעם שדרור מאשר "בוצע" — אני מסמן `[x]`. משימות חדשות מתווספות בסוף עם תאריך.

---

## פעיל / ממתינות לדרור

### עורך + תוכן
- [ ] להחליף את תמונות הראשית והמשנית לכל מדינה לפי תיקיית מיפוי שדרור ישלח (ממתין)
- [ ] קובץ כתב יד "its about TIME" באיכות גבוהה (כרגע חיתוך מתוך screenshot)
- [ ] להחליף את אייקון האינסטגרם בלוגו שדרור ישלח (ממתין; ניתן להחליף גם דרך עורך התמונות)
- [x] תוכן ל-`/writing/` — הדף עוד לא קיים → **נוצר**, נטען מ-`content/pages/writing.md`
- [ ] להתקין Obsidian Git plugin ולחבר את `content/` כ-vault (ראו `content/README.md`)
- [ ] בעריכת תוכן ב-Obsidian — לבדוק שאין override קודם ב-Supabase שתופס עדיפות (אם יש, ללחוץ סל פסולת בעורך לאיפוס)
- [ ] להוסיף כתב יד "writing" כדי שאפשר יהיה לכלול אותו בוילון Explore (כרגע מוסתר)

### החלטות עתידיות
- [ ] צמצום RLS לפני "השקה אמיתית" — כרגע site_text / site_image / mural_tiles פתוחים לכל מי שיש לו את הpublishable key
- [ ] לשקול variant שלישי לטאבלט (כרגע רק mobile <768, desktop >=768; iPad נופל ב-desktop)
- [ ] אם דרור מוסיף label חדש לאריח — צריך deploy חדש בשביל ש-/murals/<slug>/ ייווצר. אם זה מפריע — לעבור ל-SSR לראוט הזה (בלבד)

---

## בוצע (היסטוריה מצומצמת)

### סשן 2026-06-18
- [x] **תפריט Explore כווילון** — במקום שורת הקישורים יש כפתור EXPLORE שמאל למעלה, וכשלוחצים יורד וילון שחור מלא מסך עם כתב יד לבן של about/Murals/Portraits/Prints (Esc סוגר)
- [x] **תמונה אחת** בסקציות portraits + prints בדף הבית במקום 3
- [x] **תיקון באג**: כותרות "Murals/Portraits/Prints" בכתב יד היו מוסתרות (wrapper של ה-editor ננעל על width:0 לתמונות שטוענות עצלות) — תוקן ב-`image-editor.ts`
- [x] **חיבור לאובסידיאן**: `content/pages/*.md` ניתן לעריכה ישירה ב-Obsidian; Astro Content Collections (`src/content.config.ts`) קוראים בזמן build; דפי about/murals/portraits/prints/writing/home נטענים מ-MD כברירת מחדל, ו-site_text overrides עדיין מנצחים. כולל README הסבר ל-`content/README.md`

### אתר (תוכן ועיצוב)
- [x] דף הבית: רקע מנט, hero "trust the process", תפריט Times, identity, 4 בלוקי סקציה עם תת־כותרות איטליק, 3 תמונות תצוגה לפורטרייטס + פרינטס
- [x] /about/ — רקע שחור, "its about TIME" + "a trust in process" + סיפור, yoga figure float-right, "follow the jounrey... mural"
- [x] /murals/ — רקע שחור, "Murals" + "the jounrey" + פסקה, ועכשיו canvas free-positioning מ-Supabase
- [x] /murals/[slug]/ — דפי מיקומים דינמיים נוצרים מ-page+label של mural_tiles
- [x] /portraits/ — 46 דיוקנאות, פסיפס 3 עמודות מחשב / 2 מובייל, כותרת בכתב יד מהופך
- [x] /prints/ — 15 הדפסים, אותו פסיפס, "the sale"
- [x] /upload/ — טופס FormSubmit שולח למייל של שאלא, עם מצלמה/גלריה
- [x] BaseLayout עם `bare` prop מסתיר Header/Footer ישנים בדפים החדשים
- [x] עיבוד EXIF + HEIC→JPG + resize לכל התמונות המקוריות מדרור

### עורך ויזואלי (הסשנים האחרונים)
- [x] עורך canvas של תמונות במורלס (Supabase mural_tiles)
- [x] טוקן SHA-256 גייט בכל הסקריפטים
- [x] עורך טקסט: תוכן, פונט (13 פונטים), גודל, משקל, איטליק, צבע, סיבוב, הזזה
- [x] עורך תמונות: drag, resize, rotate, scale, replace upload, reset
- [x] תפריט ניווט צף (← → ⌂ + pages dropdown + view)
- [x] variants per-viewport (`@mobile` / `@desktop`) — שמירה מופרדת + fallback
- [x] auto-tagging של p/h1-h6/li/a/button/span — דף חדש מקבל עורך מיידית
- [x] שמירה אוטומטית עם debounce 500ms על שדות טקסט + Realtime sync בין מכשירים
- [x] click frame (12px מהקצה) = drag, click body = edit
- [x] single click = edit, double click = navigate על קישורים/כפתורים
- [x] תיקון bug של scroll במובייל (touch-action: none) + הסרת padding שהפר את הpublic layout
- [x] גלילה אוטומטית כשגוררים אריח קרוב לקצה viewport
- [x] הקנבס גדל אוטומטית כשמזיזים אריח למטה

### תשתית
- [x] Cloudflare Pages env vars: PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_KEY
- [x] Supabase tables: mural_tiles, site_text, site_image (כולם עם GRANT לanon)
- [x] טוקן עריכה: `80nl4NHCW-cUk-3GL1P8zg` (SHA-256: `1b74c41ae62fd8c45c9c6b129291144bb67598d7ae3110b589e141428e95ef67`)

---

## טכני — איך להמשיך בסשן הבא

- **Token**: `80nl4NHCW-cUk-3GL1P8zg`. URL מלא: `https://shalagh.com/?edit=80nl4NHCW-cUk-3GL1P8zg`
- **להחליף Token**: `node -e "const c=require('crypto');const t=c.randomBytes(16).toString('base64url');console.log('TOKEN:',t,'HASH:',c.createHash('sha256').update(t).digest('hex'))"` → להחליף `EDIT_TOKEN_HASH` בכל ארבעת ה-scripts (`murals-board.ts`, `text-editor.ts`, `image-editor.ts`, `edit-nav.ts`)
- **גישה מ-מחשב/מכשיר חדש**: לפתוח את ה-URL המלא פעם אחת; ה-token נשמר ב-`localStorage.shalagh.murals.editToken` + מוסתר מה-URL bar
- **דחיפה לאתר**: כל push ל-`main` מפעיל build ב-Cloudflare Pages. תוך 1-2 דקות באוויר.
- **לוודא RLS לפני השקה רחבה**: כרגע `public.site_text`, `public.site_image`, `public.mural_tiles` פתוחים לכל אחד עם ה-publishable key. תוכל לצמצם לפי IP/header/auth ב-RLS policies לפני שהאתר עובר לקהל רחב יותר.
- **תיעוד אגרסיבי יותר**: `~/.claude/projects/.../memory/project_shalagh_quinn_art.md` + `editor_system.md` מכילים את הארכיטקטורה המלאה.
