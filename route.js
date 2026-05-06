import * as cheerio from "cheerio";

const WOL_BASE = "https://wol.jw.org";

const LANGUAGE_MAP = {
  en: { label: "English", path: "/en/wol/h/r1/lp-e", dateLocale: "en-US" },
  es: { label: "Español", path: "/es/wol/h/r4/lp-s", dateLocale: "es-ES" },
  fr: { label: "Français", path: "/fr/wol/h/r30/lp-f", dateLocale: "fr-FR" },
  pt: { label: "Português", path: "/pt/wol/h/r5/lp-t", dateLocale: "pt-PT" },
  de: { label: "Deutsch", path: "/de/wol/h/r10/lp-x", dateLocale: "de-DE" }
};

const BOOK_ID_BY_ENGLISH_NAME = {
  genesis: "genesis", exodus: "exodus", leviticus: "leviticus", numbers: "numbers", deuteronomy: "deuteronomy",
  joshua: "joshua", judges: "judges", ruth: "ruth", "1 samuel": "1_samuel", "2 samuel": "2_samuel",
  "1 kings": "1_kings", "2 kings": "2_kings", "1 chronicles": "1_chronicles", "2 chronicles": "2_chronicles",
  ezra: "ezra", nehemiah: "nehemiah", esther: "esther", job: "job", psalms: "psalms", psalm: "psalms",
  proverbs: "proverbs", ecclesiastes: "ecclesiastes", "song of solomon": "song_of_solomon", isaiah: "isaiah",
  jeremiah: "jeremiah", lamentations: "lamentations", ezekiel: "ezekiel", daniel: "daniel", hosea: "hosea",
  joel: "joel", amos: "amos", obadiah: "obadiah", jonah: "jonah", micah: "micah", nahum: "nahum",
  habakkuk: "habakkuk", zephaniah: "zephaniah", haggai: "haggai", zechariah: "zechariah", malachi: "malachi",
  matthew: "matthew", mark: "mark", luke: "luke", john: "john", acts: "acts", romans: "romans",
  "1 corinthians": "1_corinthians", "2 corinthians": "2_corinthians", galatians: "galatians", ephesians: "ephesians",
  philippians: "philippians", colossians: "colossians", "1 thessalonians": "1_thessalonians", "2 thessalonians": "2_thessalonians",
  "1 timothy": "1_timothy", "2 timothy": "2_timothy", titus: "titus", philemon: "philemon", hebrews: "hebrews",
  james: "james", "1 peter": "1_peter", "2 peter": "2_peter", "1 john": "1_john", "2 john": "2_john", "3 john": "3_john",
  jude: "jude", revelation: "revelation"
};

const cache = new Map();

export async function GET(request) {
  const url = new URL(request.url);
  const lang = normaliseLanguage(url.searchParams.get("lang") || "en");
  const dateParam = url.searchParams.get("date");
  const targetDate = dateParam ? new Date(`${dateParam}T00:00:00`) : new Date();
  const cacheKey = `${lang}:${toISODate(targetDate)}`;
  const cached = cache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) return Response.json(cached.payload);

  try {
    const dailyTest = await fetchDailyTest({ lang, targetDate });
    const payload = { ok: true, data: dailyTest, meta: { cacheKey, fetchedAt: new Date().toISOString(), source: "wol.jw.org" } };
    cache.set(cacheKey, { payload, expiresAt: endOfDayTimestamp() });
    return Response.json(payload, { headers: { "Access-Control-Allow-Origin": "*" } });
  } catch (error) {
    return Response.json({
      ok: false,
      error: "DAILY_TEXT_PARSE_FAILED",
      message: "Today's test is unavailable. Please view the daily text directly on wol.jw.org.",
      sourceUrl: WOL_BASE + LANGUAGE_MAP[lang].path,
      debug: process.env.NODE_ENV === "development" ? String(error?.message || error) : undefined
    }, { status: 502, headers: { "Access-Control-Allow-Origin": "*" } });
  }
}

async function fetchDailyTest({ lang = "en", targetDate = new Date() }) {
  const language = LANGUAGE_MAP[lang] || LANGUAGE_MAP.en;
  const sourceUrl = WOL_BASE + language.path;
  const html = await fetchText(sourceUrl);
  const entry = parseWolDailyEntry({ html, lang, targetDate, sourceUrl });
  return {
    date: toISODate(targetDate), displayDate: entry.displayDate, language: lang,
    scriptureText: entry.scriptureText, reference: entry.reference, comments: entry.comments,
    sourceUrl, publicationSource: entry.publicationSource,
    tags: inferBasicTags(entry.scriptureText + " " + entry.comments.join(" ")),
    options: []
  };
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { "user-agent": "DaysTestPrototype/1.0", accept: "text/html" }, next: { revalidate: 60 * 60 * 12 } });
  if (!response.ok) throw new Error(`WOL fetch failed: ${response.status}`);
  return response.text();
}

function parseWolDailyEntry({ html, lang = "en", targetDate = new Date(), sourceUrl }) {
  const $ = cheerio.load(html);
  const headings = $("h2").toArray();
  if (!headings.length) throw new Error("No daily-text headings found");
  const wanted = createDateMatchers({ targetDate, lang });
  let targetHeading = null;
  for (const heading of headings) {
    const headingText = cleanText($(heading).text());
    if (wanted.some((match) => normaliseForMatch(headingText).includes(match))) { targetHeading = heading; break; }
  }
  if (!targetHeading) throw new Error(`No matching daily-text heading for ${toISODate(targetDate)}`);
  const displayDate = cleanText($(targetHeading).text());
  const entryNodes = collectEntryNodesUntilNextHeading($, targetHeading);
  if (entryNodes.length < 2) throw new Error("Matched heading but not enough content nodes found");
  const scriptureNode = entryNodes[0];
  const commentNodes = entryNodes.slice(1);
  const scriptureTextRaw = cleanText($(scriptureNode).text());
  const referenceAnchor = $(scriptureNode).find("a").first();
  const referenceDisplay = cleanText(referenceAnchor.text());
  const scriptureText = stripReferenceFromScripture(scriptureTextRaw, referenceDisplay);
  const publicationSourceAnchor = $(commentNodes[commentNodes.length - 1]).find("a").last();
  const publicationSource = publicationSourceAnchor.length ? { display: cleanText(publicationSourceAnchor.text()), url: absoluteUrl(publicationSourceAnchor.attr("href"), sourceUrl) } : null;
  const comments = commentNodes.map((node) => cleanText($(node).text())).map((text) => publicationSource?.display ? text.replace(publicationSource.display, "").trim() : text).filter(Boolean);
  return { displayDate, scriptureText, reference: parseReference(referenceDisplay, referenceAnchor.attr("href"), sourceUrl), comments, publicationSource };
}

function collectEntryNodesUntilNextHeading($, heading) {
  const nodes = [];
  let current = $(heading).next();
  while (current.length) {
    if (current.is("h2")) break;
    const text = cleanText(current.text());
    if (text && !looksLikeNavigation(text)) nodes.push(current.get(0));
    current = current.next();
  }
  return nodes;
}

function parseReference(referenceDisplay, referenceHref, sourceUrl) {
  const display = referenceDisplay || "";
  const bookName = extractBookName(display);
  return { display, bookId: BOOK_ID_BY_ENGLISH_NAME[bookName.toLowerCase()] || null, bookName, url: absoluteUrl(referenceHref, sourceUrl) };
}

function extractBookName(referenceDisplay) {
  const abbreviationMap = { gen:"Genesis", ex:"Exodus", lev:"Leviticus", num:"Numbers", deut:"Deuteronomy", josh:"Joshua", judg:"Judges", ruth:"Ruth", "1 sam":"1 Samuel", "2 sam":"2 Samuel", "1 ki":"1 Kings", "2 ki":"2 Kings", "1 chron":"1 Chronicles", "2 chron":"2 Chronicles", ezra:"Ezra", neh:"Nehemiah", esther:"Esther", job:"Job", ps:"Psalms", prov:"Proverbs", eccl:"Ecclesiastes", song:"Song of Solomon", isa:"Isaiah", jer:"Jeremiah", lam:"Lamentations", ezek:"Ezekiel", dan:"Daniel", hos:"Hosea", joel:"Joel", amos:"Amos", obad:"Obadiah", jonah:"Jonah", mic:"Micah", nah:"Nahum", hab:"Habakkuk", zeph:"Zephaniah", hag:"Haggai", zech:"Zechariah", mal:"Malachi", matt:"Matthew", mark:"Mark", luke:"Luke", john:"John", acts:"Acts", rom:"Romans", "1 cor":"1 Corinthians", "2 cor":"2 Corinthians", gal:"Galatians", eph:"Ephesians", phil:"Philippians", col:"Colossians", "1 thess":"1 Thessalonians", "2 thess":"2 Thessalonians", "1 tim":"1 Timothy", "2 tim":"2 Timothy", titus:"Titus", philem:"Philemon", heb:"Hebrews", jas:"James", "1 pet":"1 Peter", "2 pet":"2 Peter", "1 john":"1 John", "2 john":"2 John", "3 john":"3 John", jude:"Jude", rev:"Revelation" };
  const cleaned = referenceDisplay.replace(/[.—–-].*$/, "").replace(/\s+/g, " ").trim().replace(/\.$/, "").toLowerCase();
  const bookPart = cleaned.replace(/\s*\d+:.*$/, "").replace(/\.$/, "");
  return abbreviationMap[bookPart] || titleCase(bookPart);
}

function stripReferenceFromScripture(scriptureTextRaw, referenceDisplay) {
  if (!referenceDisplay) return scriptureTextRaw;
  return scriptureTextRaw.replace(new RegExp(escapeRegExp("—" + referenceDisplay) + "\\.?$"), "").replace(new RegExp(escapeRegExp("-" + referenceDisplay) + "\\.?$"), "").replace(referenceDisplay, "").replace(/[—–-]\s*$/, "").trim();
}

function createDateMatchers({ targetDate, lang }) {
  const language = LANGUAGE_MAP[lang] || LANGUAGE_MAP.en;
  const longDate = new Intl.DateTimeFormat(language.dateLocale, { weekday: "long", month: "long", day: "numeric" }).format(targetDate);
  return [longDate, longDate.replace(/,/g, "")].map(normaliseForMatch);
}

function inferBasicTags(text) {
  const lower = text.toLowerCase();
  const tags = [];
  [["forgive","forgiveness"],["mercy","mercy"],["love","love"],["faith","faith"],["wisdom","wisdom"],["endure","endurance"],["anxiety","comfort"],["prayer","prayer"],["kingdom","kingdom"],["preach","preaching"],["humble","humility"],["joy","joy"],["peace","peace"]].forEach(([needle, tag]) => { if (lower.includes(needle)) tags.push(tag); });
  return [...new Set(tags)];
}
function normaliseLanguage(lang) { const base = String(lang || "en").toLowerCase().split("-")[0]; return LANGUAGE_MAP[base] ? base : "en"; }
function cleanText(text) { return String(text || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim(); }
function normaliseForMatch(text) { return cleanText(text).toLowerCase().replace(/[.,]/g, "").replace(/\u00a0/g, " "); }
function looksLikeNavigation(text) { const lower = text.toLowerCase(); return ["watchtower online library", "welcome", "share", "log in", "log out"].some((term) => lower.includes(term)); }
function absoluteUrl(href, sourceUrl) { if (!href) return null; return new URL(href, sourceUrl).toString(); }
function toISODate(date) { return date.toISOString().slice(0, 10); }
function endOfDayTimestamp() { const date = new Date(); date.setHours(23, 59, 59, 999); return date.getTime(); }
function titleCase(text) { return String(text || "").split(" ").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" "); }
function escapeRegExp(text) { return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
