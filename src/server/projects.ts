import type { Database } from "bun:sqlite";
import { MAX_VIEW_BYTES } from "./bookmarks";

/** What one reader collects from the library for one piece of work ("My amplifier"): places in books and own notes, in the order the reader keeps them. */
export interface Project {
  id: number;
  title: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  /** How many items it holds. */
  items: number;
}

/**
 * One entry of a project. With a `bookId` it is a place in that book (`view`, the shape the reader reports and
 * a bookmark keeps) and, for text formats, the passage as `quote`; without one it is the reader's own note.
 */
export interface ProjectItem {
  id: number;
  bookId: string | null;
  view: unknown;
  title: string;
  comment: string;
  quote: string;
  createdAt: number;
}

export const MAX_PROJECTS = 200;
export const MAX_ITEMS = 1000;
export const MAX_TITLE = 200;
export const MAX_DESCRIPTION = 2000;
export const MAX_COMMENT = 5000;
export const MAX_QUOTE = 2000;

export class ProjectError extends Error {}

/** A trimmed text of at most `max` characters; `required` texts must not end up empty. Throws a ProjectError with a short code. */
export function cleanText(value: unknown, max: number, what: string, required = false): string {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string") throw new ProjectError(`bad ${what}`);
  const text = value.trim();
  if (required && !text) throw new ProjectError(`${what} required`);
  if (text.length > max) throw new ProjectError(`${what} too long`);
  return text;
}

/** A view must be a JSON object that stays small; anything else cannot be a place in a book. */
export function cleanView(view: unknown): unknown {
  if (view === undefined || view === null) return null;
  if (typeof view !== "object" || Array.isArray(view) || JSON.stringify(view).length > MAX_VIEW_BYTES) throw new ProjectError("bad view");
  return view;
}

interface ProjectRow {
  id: number;
  title: string;
  description: string;
  created_at: number;
  updated_at: number;
  items: number;
}

interface ItemRow {
  id: number;
  book_id: string | null;
  view: string | null;
  title: string;
  comment: string;
  quote: string;
  created_at: number;
}

const toProject = (r: ProjectRow): Project => ({ id: r.id, title: r.title, description: r.description, createdAt: r.created_at, updatedAt: r.updated_at, items: r.items });
const toItem = (r: ItemRow): ProjectItem => ({ id: r.id, bookId: r.book_id, view: r.view === null ? null : JSON.parse(r.view), title: r.title, comment: r.comment, quote: r.quote, createdAt: r.created_at });

const PROJECT = "SELECT p.id, p.title, p.description, p.created_at, p.updated_at, (SELECT COUNT(*) FROM project_items i WHERE i.project_id = p.id) AS items FROM projects p";

/** A reader's projects. Every call names the owner, and a project of somebody else is simply not there. */
export class Projects {
  constructor(private readonly db: Database) {}

  list(userId: number): Project[] {
    return (this.db.query(`${PROJECT} WHERE p.user_id = ? ORDER BY p.updated_at DESC, p.id DESC`).all(userId) as ProjectRow[]).map(toProject);
  }

  get(userId: number, id: number): Project | null {
    const row = this.db.query(`${PROJECT} WHERE p.user_id = ? AND p.id = ?`).get(userId, id) as ProjectRow | null;
    return row ? toProject(row) : null;
  }

  /** Throws a ProjectError ("title required", "title too long", "too many"). */
  create(userId: number, title: unknown, description?: unknown): Project {
    const name = cleanText(title, MAX_TITLE, "title", true);
    const about = cleanText(description, MAX_DESCRIPTION, "description");
    if ((this.db.query("SELECT COUNT(*) AS n FROM projects WHERE user_id = ?").get(userId) as { n: number }).n >= MAX_PROJECTS) throw new ProjectError("too many");
    const now = Date.now();
    const { lastInsertRowid } = this.db.query("INSERT INTO projects (user_id, title, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(userId, name, about, now, now);
    return { id: Number(lastInsertRowid), title: name, description: about, createdAt: now, updatedAt: now, items: 0 };
  }

  /** Changes the title and/or the description that are given; false when the project is not this reader's. */
  update(userId: number, id: number, change: { title?: unknown; description?: unknown }): boolean {
    const current = this.get(userId, id);
    if (!current) return false;
    const title = change.title === undefined ? current.title : cleanText(change.title, MAX_TITLE, "title", true);
    const description = change.description === undefined ? current.description : cleanText(change.description, MAX_DESCRIPTION, "description");
    this.db.query("UPDATE projects SET title = ?, description = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(title, description, Date.now(), id, userId);
    return true;
  }

  /** Removes the project with its items; the books themselves are not touched. */
  remove(userId: number, id: number): boolean {
    return this.db.query("DELETE FROM projects WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
  }

  /** The items in the reader's order, or null when the project is not this reader's. */
  items(userId: number, id: number): ProjectItem[] | null {
    if (!this.get(userId, id)) return null;
    return (this.db.query("SELECT id, book_id, view, title, comment, quote, created_at FROM project_items WHERE project_id = ? ORDER BY position, id").all(id) as ItemRow[]).map(toItem);
  }

  /** Adds at the end. Null when the project is not this reader's; throws a ProjectError for a bad item. */
  addItem(userId: number, id: number, input: { bookId?: string | null; view?: unknown; title: unknown; comment?: unknown; quote?: unknown }): ProjectItem | null {
    if (!this.get(userId, id)) return null;
    const title = cleanText(input.title, MAX_TITLE, "title", true);
    const comment = cleanText(input.comment, MAX_COMMENT, "comment");
    const quote = cleanText(input.quote, MAX_QUOTE, "quote");
    const bookId = input.bookId ?? null;
    const view = bookId === null ? null : cleanView(input.view);
    if ((this.db.query("SELECT COUNT(*) AS n FROM project_items WHERE project_id = ?").get(id) as { n: number }).n >= MAX_ITEMS) throw new ProjectError("too many");
    const now = Date.now();
    const next = (this.db.query("SELECT COALESCE(MAX(position), -1) + 1 AS n FROM project_items WHERE project_id = ?").get(id) as { n: number }).n;
    const { lastInsertRowid } = this.db
      .query("INSERT INTO project_items (project_id, position, book_id, view, title, comment, quote, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, next, bookId, view === null ? null : JSON.stringify(view), title, comment, quote, now);
    this.touch(id, now);
    return { id: Number(lastInsertRowid), bookId, view, title, comment, quote, createdAt: now };
  }

  /** Changes the title, comment and/or quote that are given (the place in the book stays). */
  updateItem(userId: number, id: number, itemId: number, change: { title?: unknown; comment?: unknown; quote?: unknown }): boolean {
    const list = this.items(userId, id);
    const current = list?.find((i) => i.id === itemId);
    if (!current) return false;
    const title = change.title === undefined ? current.title : cleanText(change.title, MAX_TITLE, "title", true);
    const comment = change.comment === undefined ? current.comment : cleanText(change.comment, MAX_COMMENT, "comment");
    const quote = change.quote === undefined ? current.quote : cleanText(change.quote, MAX_QUOTE, "quote");
    this.db.query("UPDATE project_items SET title = ?, comment = ?, quote = ? WHERE id = ? AND project_id = ?").run(title, comment, quote, itemId, id);
    this.touch(id);
    return true;
  }

  removeItem(userId: number, id: number, itemId: number): boolean {
    if (!this.get(userId, id)) return false;
    const gone = this.db.query("DELETE FROM project_items WHERE id = ? AND project_id = ?").run(itemId, id).changes > 0;
    if (gone) this.touch(id);
    return gone;
  }

  /** Puts the items in this order. It must name every item of the project exactly once, otherwise nothing changes and the answer is false. */
  reorder(userId: number, id: number, order: number[]): boolean {
    const list = this.items(userId, id);
    if (!list || order.length !== list.length || new Set(order).size !== order.length || !order.every((n) => list.some((i) => i.id === n))) return false;
    this.db.transaction(() => {
      order.forEach((itemId, position) => this.db.query("UPDATE project_items SET position = ? WHERE id = ? AND project_id = ?").run(position, itemId, id));
      this.touch(id);
    })();
    return true;
  }

  private touch(id: number, now = Date.now()): void {
    this.db.query("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, id);
  }
}
