"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { OrgActionState } from "@/app/(app)/org/actions";
import { defaultOrgRole, postChipLabel, type PostPatch } from "@/lib/org";
import type { OrgPostView } from "@/server/services/org";
import { PersonPicker, type NewPersonData, type PersonOption } from "./PersonPicker";

/** What the post chips need from the board (every call goes through the board's queue + version). */
export interface PostHandlers {
  people: PersonOption[];
  createPost: (input: { departmentId: string; title: string; personId: string | null; hiring: boolean; hiringRoleTitle: string | null }) => Promise<OrgActionState>;
  updatePost: (id: string, patch: PostPatch) => Promise<OrgActionState>;
  removePost: (id: string) => Promise<OrgActionState>;
  /** "+ New person" on a post: creates, links to the company and makes them its holder. */
  createPersonForPost: (postId: string, data: NewPersonData) => Promise<OrgActionState>;
}

/** Closes a popover on an outside click or Escape. */
function usePopover(): [boolean, (v: boolean | ((x: boolean) => boolean)) => void, React.RefObject<HTMLSpanElement | null>] {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return [open, setOpen, ref];
}

const CHIP = "inline-flex h-[22px] max-w-full items-center gap-1 truncate rounded-full px-2 text-[11.5px] font-semibold leading-none";

/** Solid green = held (the person's name); dashed orange = hiring (the role title); dashed grey = empty. */
export function chipClass(p: Pick<OrgPostView, "personId" | "hiring">, highlighted = false): string {
  const tone = p.personId ? "bg-accent text-accent-ink" : p.hiring ? "border border-dashed border-warn bg-warn-soft text-warn" : "border border-dashed border-line text-muted";
  return `${CHIP} ${tone} ${highlighted ? "ring-2 ring-offset-1 ring-ink ring-offset-surface" : ""}`;
}

function chipTitle(p: OrgPostView): string {
  if (p.personId) return `${p.title ? `${p.title}: ` : ""}${p.personFullName ?? p.personName ?? ""}`;
  if (p.hiring) return `Найм: ${p.hiringRoleTitle ?? p.title}`;
  return p.title ? `${p.title} — вакантно` : "Пост — вакантно";
}

/** One post on a department card. Founders click it to edit (person / hiring / title / remove). */
export function PostChip({ post, editable, highlighted, h, deptName }: { post: OrgPostView; editable: boolean; highlighted: boolean; h: PostHandlers; deptName: string }) {
  const [open, setOpen, ref] = usePopover();
  const label = postChipLabel(post);
  const testState = post.personId ? "held" : post.hiring ? "hiring" : "empty";
  if (!editable) {
    return (
      <span className={chipClass(post, highlighted)} title={chipTitle(post)} data-testid="org-post" data-state={testState}>
        {label}
      </span>
    );
  }
  return (
    <span ref={ref} className="relative inline-flex max-w-full">
      <button
        type="button"
        className={chipClass(post, highlighted)}
        title={chipTitle(post)}
        aria-expanded={open}
        aria-label={`Post ${chipTitle(post)} — edit`}
        onClick={() => setOpen((v) => !v)}
        data-testid="org-post"
        data-state={testState}
      >
        {label}
      </button>
      {open && (
        <PostPopover title={`Post in ${deptName}`}>
          <PostEditor post={post} departmentId={post.departmentId} h={h} onDone={() => setOpen(false)} />
        </PostPopover>
      )}
    </span>
  );
}

/** "+ пост" on a department card (founders). */
export function AddPostButton({ departmentId, deptName, h }: { departmentId: string; deptName: string; h: PostHandlers }) {
  const [open, setOpen, ref] = usePopover();
  return (
    <span ref={ref} className="relative inline-flex">
      <button type="button" className={`${CHIP} border border-dashed border-line font-normal text-muted hover:text-ink`} aria-expanded={open} aria-label={`Add a post to ${deptName}`} onClick={() => setOpen((v) => !v)} data-testid="org-add-post">
        + пост
      </button>
      {open && (
        <PostPopover title={`New post in ${deptName}`}>
          <PostEditor post={null} departmentId={departmentId} h={h} onDone={() => setOpen(false)} />
        </PostPopover>
      )}
    </span>
  );
}

function PostPopover({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div role="dialog" aria-label={title} className="card-raised absolute left-0 top-7 z-30 flex w-[270px] flex-col gap-2 p-2.5 text-[13px]" data-testid="org-post-popover">
      <p className="text-[12px] font-semibold">{title}</p>
      {children}
    </div>
  );
}

type Mode = "person" | "hiring";

/**
 * Edits or creates a post: its title, then either a person of this company (or "+ New
 * person") or "hiring" + the role being hired for — never both.
 */
function PostEditor({ post, departmentId, h, onDone }: { post: OrgPostView | null; departmentId: string; h: PostHandlers; onDone: () => void }) {
  const uid = useId();
  const [title, setTitle] = useState(post?.title ?? "");
  const [mode, setMode] = useState<Mode>(post?.hiring ? "hiring" : "person");
  const [personId, setPersonId] = useState(post?.personId ?? "");
  const [role, setRole] = useState(post?.hiringRoleTitle ?? post?.title ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const finish = async (p: Promise<OrgActionState>) => {
    setBusy(true);
    const res = await p;
    setBusy(false);
    if (res.ok) onDone();
    else setError(res.error ?? "Not saved");
    return res;
  };

  const save = () => {
    setError(null);
    if (mode === "hiring" && !role.trim()) {
      setError("Which role are you hiring for?");
      return;
    }
    const holder = mode === "hiring" ? { personId: null, hiring: true, hiringRoleTitle: role.trim() } : { personId: personId || null, hiring: false, hiringRoleTitle: null };
    void finish(post ? h.updatePost(post.id, { title: title.trim(), ...holder }) : h.createPost({ departmentId, title: title.trim(), ...holder }));
  };

  const createPerson = async (data: NewPersonData): Promise<OrgActionState> => {
    let id = post?.id;
    if (!id) {
      const created = await h.createPost({ departmentId, title: title.trim(), personId: null, hiring: false, hiringRoleTitle: null });
      if (!created.ok || !created.id) return created;
      id = created.id;
    }
    return finish(h.createPersonForPost(id, data));
  };

  return (
    <div className="flex flex-col gap-2" data-testid="org-post-editor">
      <div>
        <label className="label" htmlFor={`${uid}-title`}>
          Post title
        </label>
        <input id={`${uid}-title`} className="input h-8 text-[13px]" value={title} maxLength={160} placeholder="Менеджер по продажам" onChange={(e) => setTitle(e.target.value)} autoFocus />
      </div>
      <div role="radiogroup" aria-label="Who holds it" className="flex gap-1">
        {(["person", "hiring"] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} className={`btn btn-sm flex-1 ${mode === m ? "btn-primary" : ""}`} onClick={() => setMode(m)}>
            {m === "person" ? "Person" : "Hiring"}
          </button>
        ))}
      </div>
      {mode === "person" ? (
        <PersonPicker
          id={`${uid}-person`}
          label="Person on this post"
          value={personId}
          people={h.people}
          onChange={setPersonId}
          defaultRole={defaultOrgRole(title || role || "Сотрудник")}
          onCreate={createPerson}
        />
      ) : (
        <div>
          <label className="label" htmlFor={`${uid}-role`}>
            Hiring for (role title)
          </label>
          <input id={`${uid}-role`} className="input h-8 text-[13px]" value={role} maxLength={160} placeholder="Менеджер по продажам" onChange={(e) => setRole(e.target.value)} />
        </div>
      )}
      {error && (
        <p role="alert" className="text-[12px] text-risk">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={save}>
          {busy ? "Saving…" : post ? "Save" : "Add post"}
        </button>
        {post && (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void finish(h.removePost(post.id))}>
            Remove post
          </button>
        )}
        <button type="button" className="btn btn-sm btn-ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}
