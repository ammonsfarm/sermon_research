import { BIBLE, type BiblePassage, bibleState, type BibleState, type Book, bookByNumber, bookBySlug, BOOKS, chapterPath, chapterVerses, findVerses, parseReference, passageLabel, searchBible, startBibleImport, type Verse } from "./bible.ts";
import { chrome, clientIp, type Context, redirect, requireAdmin } from "./context.ts";
import { html, type Html, page } from "./html.ts";
import { gate, SEARCHES_PER_HOUR } from "./research.ts";
import { HOUR_MS, recordUse, usedSince } from "./usage.ts";
import { notFoundView } from "./views.ts";

/** An import that has reported nothing for this long can be started again from the admin page. */
const QUIET_MS = 15 * 60_000;

function searchForm(query = ""): Html {
  return html`<form method="get" action="/bible" class="row filters">
<input name="q" type="search" value="${query}" placeholder="A reference like John 3:16, a phrase, or an idea" aria-label="Search the Bible" class="grow">
<button type="submit">Search</button>
${query ? html`<a href="/bible">Clear</a>` : ""}
</form>`;
}

function credit(): Html {
  return html`<p class="hint">${BIBLE.name} (${BIBLE.short}), in the public domain. <a href="${BIBLE.about}" rel="noopener">About this translation</a></p>`;
}

function notAdded(context: Context, state: BibleState | null): Response {
  const admin = context.session?.user.role === "admin";
  return page("Bible", html`<h1>Bible</h1>
<p class="empty">${state?.status === "working" ? "The Bible is being added. Check back in a few minutes." : "The Bible hasn't been added to this site yet."}${admin ? html` <a href="/admin/bible">Admin → Bible</a>` : ""}</p>`, chrome(context));
}

function bookList(books: readonly Book[]): Html {
  return html`<ul class="bible-books">${books.map((book) => html`<li><a href="/bible/${book.slug}">${book.name}</a></li>`)}</ul>`;
}

/** GET /bible : the books, or search results for `q`. A reference goes straight to its chapter. */
export async function biblePage(context: Context): Promise<Response> {
  const blocked = await gate(context);
  if (blocked) return blocked;
  const { db } = context;
  const state = await bibleState(db);
  if (!state?.verses) return notAdded(context, state);
  const query = (context.url.searchParams.get("q") ?? "").trim().slice(0, 200);
  if (!query) {
    return page("Bible", html`<h1>Bible</h1>
<p class="lead">Read the ${BIBLE.name}, or search it by reference, by words, or by what a passage is about.</p>
${searchForm()}
<h2>Old Testament</h2>
${bookList(BOOKS.filter((book) => book.testament === "old"))}
<h2>New Testament</h2>
${bookList(BOOKS.filter((book) => book.testament === "new"))}
${credit()}`, { wide: true, ...chrome(context) });
  }

  const reference = parseReference(query);
  if (reference) return redirect(reference.chapter ? chapterPath(reference.book, reference.chapter, reference.verse) : `/bible/${reference.book.slug}`);

  const worded = await findVerses(db, query, 20);
  let passages: BiblePassage[] = [];
  let note = "";
  if (state.indexed === 0) {
    note = "Showing verses with these words only; search by meaning isn't ready yet.";
  } else {
    const bucket = context.session ? `search-user:${context.session.user.id}` : `search-ip:${clientIp(context.request)}`;
    if (await usedSince(db, bucket, Date.now() - HOUR_MS) >= SEARCHES_PER_HOUR) {
      note = "Showing verses with these words only; search by meaning is paused for this hour.";
    } else {
      await recordUse(db, [bucket]);
      try {
        passages = await searchBible(context.env, query, 10);
      } catch (error) {
        console.error("bible search failed", error);
        note = "Search by meaning isn't available right now; showing verses with these words.";
      }
    }
  }
  return page("Bible", html`<h1>Bible</h1>
${searchForm(query)}
${note ? html`<p class="hint">${note}</p>` : ""}
${passages.length ? html`<h2>Closest in meaning</h2>
<ol class="bible-results">${passages.map((passage) => {
    const book = bookByNumber(passage.book)!;
    return html`<li><a href="${chapterPath(book, passage.chapter, passage.verseStart)}">${passageLabel(passage)}</a><p class="scripture">${passage.text}</p></li>`;
  })}</ol>` : ""}
${worded.length ? html`<h2>Verses with these words</h2>
<ol class="bible-results">${worded.map((verse) => {
    const book = bookByNumber(verse.book)!;
    return html`<li><a href="${chapterPath(book, verse.chapter, verse.verse)}">${book.name} ${verse.chapter}:${verse.verse}</a><p class="scripture">${verse.text}</p></li>`;
  })}</ol>${worded.length === 20 ? html`<p class="hint">Showing the first 20 verses.</p>` : ""}` : ""}
${passages.length === 0 && worded.length === 0 ? html`<p class="empty">Nothing matches.</p>` : ""}
${credit()}`, chrome(context));
}

/** GET /bible/:book : the book's chapters. */
export async function bibleBookPage(context: Context, slug: string): Promise<Response> {
  const blocked = await gate(context);
  if (blocked) return blocked;
  const book = bookBySlug(slug);
  if (!book) return page("Not found", notFoundView(), { status: 404, ...chrome(context) });
  if (book.chapters === 1) return redirect(chapterPath(book, 1));
  return page(book.name, html`<p class="meta"><a href="/bible">Bible</a></p>
<h1>${book.name}</h1>
<ul class="bible-chapters">${Array.from({ length: book.chapters }, (_unused, index) => html`<li><a href="${chapterPath(book, index + 1)}">${index + 1}</a></li>`)}</ul>
${credit()}`, chrome(context));
}

/** The chapter before or after this one, across books. */
function neighbour(book: Book, chapter: number, step: -1 | 1): { book: Book; chapter: number } | null {
  const next = chapter + step;
  if (next >= 1 && next <= book.chapters) return { book, chapter: next };
  const other = bookByNumber(book.number + step);
  return other ? { book: other, chapter: step === 1 ? 1 : other.chapters } : null;
}

/** GET /bible/:book/:chapter : the chapter's text. A verse is linked as #v16. */
export async function bibleChapterPage(context: Context, slug: string, chapter: number): Promise<Response> {
  const blocked = await gate(context);
  if (blocked) return blocked;
  const book = bookBySlug(slug);
  const verses: Verse[] = book && chapter >= 1 && chapter <= book.chapters ? await chapterVerses(context.db, book.number, chapter) : [];
  if (!book || verses.length === 0) {
    const state = book ? await bibleState(context.db) : null;
    return book && !state?.verses ? notAdded(context, state) : page("Not found", notFoundView(), { status: 404, ...chrome(context) });
  }
  const heading = book.chapters === 1 ? book.name : `${book.name} ${chapter}`;
  const before = neighbour(book, chapter, -1);
  const after = neighbour(book, chapter, 1);
  const label = (place: { book: Book; chapter: number }) => place.book.chapters === 1 ? place.book.name : `${place.book.name} ${place.chapter}`;
  const turn = html`<nav class="bible-turn" aria-label="Chapters">
${before ? html`<a href="${chapterPath(before.book, before.chapter)}" rel="prev">← ${label(before)}</a>` : html`<span></span>`}
${after ? html`<a href="${chapterPath(after.book, after.chapter)}" rel="next">${label(after)} →</a>` : ""}
</nav>`;
  return page(heading, html`<p class="meta"><a href="/bible">Bible</a>${book.chapters > 1 ? html` › <a href="/bible/${book.slug}">${book.name}</a>` : ""}</p>
<h1>${heading}</h1>
${searchForm()}
<div class="scripture chapter">${verses.map((verse) => html`<span class="verse" id="v${verse.verse}"><sup>${verse.verse}</sup>${verse.text}</span> `)}</div>
${turn}
<p class="meta"><a href="/episodes?${new URLSearchParams({ q: heading }).toString()}">Sermons on ${heading}</a></p>
${credit()}`, chrome(context));
}

function statusView(state: BibleState | null): Html {
  if (!state) return html`<p class="empty">The Bible hasn't been added yet.</p>`;
  const counts = html`${state.verses.toLocaleString("en-US")} verses; ${state.indexed.toLocaleString("en-US")} of ${state.passages.toLocaleString("en-US")} passages searchable by meaning.`;
  if (state.status === "working") return html`<p class="busy-note">${state.detail ?? "Working"}</p><p class="hint">This takes a few minutes and carries on if you leave the page. ${state.verses ? counts : ""}</p>`;
  if (state.status === "failed") return html`<p class="alert">Adding the Bible stopped: ${state.error ?? "Unknown error."}</p>${state.verses ? html`<p class="hint">${counts}</p>` : ""}`;
  return html`<div class="alert-ok"><p><strong>The ${BIBLE.name} is on the site.</strong> ${counts} <a href="/bible">Open the Bible</a></p></div>
<p class="hint">Last added ${state.updatedAt.slice(0, 10)}.</p>`;
}

/** GET/POST /admin/bible : add the Bible, or add it again to pick up eBible.org's corrections. */
export async function bibleAdmin(context: Context): Promise<Response> {
  const denied = requireAdmin(context);
  if (denied) return denied;
  let state = await bibleState(context.db);
  const busy = state?.status === "working" && Date.now() - Date.parse(state.updatedAt) < QUIET_MS;
  if (context.request.method === "POST") {
    if (!busy) await startBibleImport(context.env);
    return redirect("/admin/bible");
  }
  state = await bibleState(context.db);
  return page("Bible", html`<h1>Bible</h1>
<p class="lead">Add the ${BIBLE.name} so people can read it on the Bible tab and search it by reference, by words, or by meaning.</p>
${statusView(state)}
<form method="post" action="/admin/bible">
<button type="submit"${busy ? html` disabled` : ""}>${state?.verses ? "Add it again" : `Add the ${BIBLE.name}`}</button>
</form>
<p class="hint">The text is downloaded from <a href="${BIBLE.about}" rel="noopener">eBible.org</a>, where it's in the public domain: all 66 books, without the Apocrypha. Preparing it for search by meaning uses your embeddings key once, for about a million tokens (a few cents at OpenAI's list price when this was written). Adding it again replaces the text with eBible.org's current edition.</p>`, { ...(state?.status === "working" ? { refreshSeconds: 5 } : {}), ...chrome(context) });
}
