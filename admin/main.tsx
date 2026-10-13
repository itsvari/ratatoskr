import {
  BanIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CopyIcon,
  DownloadIcon,
  EyeIcon,
  LoaderCircleIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchIcon,
  SunIcon,
  Trash2Icon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import {
  StrictMode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import type { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/class-names";
import {
  MAXIMUM_CUSTOM_SLUG_LENGTH,
  MAXIMUM_DESTINATION_LENGTH,
  MAXIMUM_TITLE_LENGTH,
  createLinkSchema,
  updateLinkSchema,
  type Link,
  type LinkStatus,
  type Session,
  type UpdateLink,
} from "../shared/contracts";
import {
  SessionExpiredError,
  createLink,
  deleteLink,
  exportLinks,
  fetchLinks,
  fetchSession,
  isAbortError,
  updateLink,
} from "./api";
import { APPEARANCES, applyStoredAppearance, useAppearance, type Appearance } from "./appearance";

const LOGOUT_HREF = "/cdn-cgi/access/logout";
const SEARCH_DELAY_MILLISECONDS = 250;
const NOTICE_DURATION_MILLISECONDS = 6000;
const MILLISECONDS_PER_MINUTE = 60_000;
const MINIMUM_EXPIRY_LEAD_MILLISECONDS = MILLISECONDS_PER_MINUTE;
const OBJECT_URL_REVOKE_DELAY_MILLISECONDS = 1000;

type SessionState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly session: Session }
  | { readonly kind: "expired" }
  | { readonly kind: "failed"; readonly message: string };

type Notice = {
  readonly id: number;
  readonly tone: "success" | "error";
  readonly message: string;
};

type Announce = (notice: Omit<Notice, "id">) => void;

type ReportError = (error: unknown) => void;

const STATUS_FILTERS = ["all", "active", "revoked"] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number];

type ListState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly links: readonly Link[];
      readonly nextCursor: string | null;
      readonly loadingMore: boolean;
    };

type PendingConfirmation = {
  readonly action: "revoke" | "delete";
  readonly link: Link;
};

type LinkActions = {
  readonly onCopy: (link: Link) => void;
  readonly onCopyPreview: (link: Link) => void;
  readonly onEdit: (link: Link) => void;
  readonly onRevoke: (link: Link) => void;
  readonly onRestore: (link: Link) => void;
  readonly onDelete: (link: Link) => void;
};

const STATUS_FILTER_LABELS: Readonly<Record<StatusFilter, string>> = {
  all: "All statuses",
  active: "Active",
  revoked: "Revoked",
};

const APPEARANCE_OPTIONS: Readonly<Record<Appearance, { readonly label: string; readonly icon: LucideIcon }>> = {
  dark: { label: "Dark", icon: MoonIcon },
  light: { label: "Light", icon: SunIcon },
  system: { label: "System", icon: MonitorIcon },
};

const dateTimeFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

function isStatusFilter(value: unknown): value is StatusFilter {
  return typeof value === "string" && (STATUS_FILTERS as readonly string[]).includes(value);
}

function isAppearance(value: unknown): value is Appearance {
  return typeof value === "string" && (APPEARANCES as readonly string[]).includes(value);
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function trimTrailingSlash(origin: string): string {
  return origin.endsWith("/") ? origin.slice(0, -1) : origin;
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function redirectUrl({ session, slug }: { readonly session: Session; readonly slug: string }): string {
  return `${trimTrailingSlash(session.shortOrigin)}/${slug}`;
}

function previewUrl({ session, slug }: { readonly session: Session; readonly slug: string }): string {
  return session.previewOrigin === null
    ? `${trimTrailingSlash(session.shortOrigin)}/${slug}+`
    : `${trimTrailingSlash(session.previewOrigin)}/${slug}`;
}

function withoutScheme(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

// datetime-local inputs speak local wall-clock time without an offset
function toLocalInputValue(iso: string | null): string {
  if (iso === null) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * MILLISECONDS_PER_MINUTE);
  return local.toISOString().slice(0, 16);
}

type ExpiryParse =
  | { readonly kind: "none" }
  | { readonly kind: "valid"; readonly iso: string }
  | { readonly kind: "invalid"; readonly message: string };

function parseExpiryInput(value: string): ExpiryParse {
  if (value === "") return { kind: "none" };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { kind: "invalid", message: "Enter a valid expiry date and time." };
  if (date.getTime() <= Date.now()) return { kind: "invalid", message: "Choose an expiry in the future." };
  return { kind: "valid", iso: date.toISOString() };
}

function minimumExpiryInputValue(): string {
  return toLocalInputValue(new Date(Date.now() + MINIMUM_EXPIRY_LEAD_MILLISECONDS).toISOString());
}

function isExpired(link: Link): boolean {
  return link.expiresAt !== null && Date.parse(link.expiresAt) <= Date.now();
}

const FIELD_LABELS: Readonly<Record<string, string>> = {
  destination: "Destination",
  title: "Title",
  slug: "Slug",
  expiresAt: "Expiry",
};

function describeValidationError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "Check the form and try again.";
  const field = issue.path[0];
  const label = typeof field === "string" ? FIELD_LABELS[field] : undefined;
  return label === undefined ? issue.message : `${label}: ${issue.message}`;
}

function formatDate(iso: string, format: Intl.DateTimeFormat): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : format.format(date);
}

async function copyToClipboard({
  text,
  label,
  announce,
}: {
  readonly text: string;
  readonly label: string;
  readonly announce: Announce;
}): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    announce({ tone: "success", message: `Copied ${label}: ${withoutScheme(text)}` });
  } catch {
    announce({ tone: "error", message: `Could not copy the ${label}. Select it and copy manually.` });
  }
}

function useDebouncedValue<Value>(value: Value, delayMilliseconds: number): Value {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMilliseconds);
    return () => window.clearTimeout(timer);
  }, [value, delayMilliseconds]);
  return debounced;
}

function App(): ReactNode {
  const [sessionState, setSessionState] = useState<SessionState>({ kind: "loading" });
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeCounter = useRef(0);

  const loadSession = useCallback((signal?: AbortSignal) => {
    setSessionState({ kind: "loading" });
    fetchSession(signal)
      .then((session) => setSessionState({ kind: "ready", session }))
      .catch((error: unknown) => {
        if (isAbortError(error)) return;
        if (error instanceof SessionExpiredError) {
          setSessionState({ kind: "expired" });
          return;
        }
        setSessionState({ kind: "failed", message: messageFromError(error) });
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadSession(controller.signal);
    return () => controller.abort();
  }, [loadSession]);

  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_DURATION_MILLISECONDS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const announce = useCallback<Announce>(({ tone, message }) => {
    noticeCounter.current += 1;
    setNotice({ id: noticeCounter.current, tone, message });
  }, []);

  const reportError = useCallback<ReportError>(
    (error) => {
      if (isAbortError(error)) return;
      if (error instanceof SessionExpiredError) {
        setSessionState({ kind: "expired" });
        return;
      }
      announce({ tone: "error", message: messageFromError(error) });
    },
    [announce],
  );

  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:text-primary-foreground"
      >
        Skip to content
      </a>
      {sessionState.kind === "ready" ? (
        <Workspace session={sessionState.session} announce={announce} reportError={reportError} />
      ) : (
        <SessionGate state={sessionState} onRetry={() => loadSession()} />
      )}
      <NoticeRegion notice={notice} onDismiss={() => setNotice(null)} />
    </>
  );
}

function Wordmark(): ReactNode {
  return <span className="text-sm font-semibold tracking-tight">Ratatoskr</span>;
}

function AppearanceSelect(): ReactNode {
  const [appearance, setAppearance] = useAppearance();
  return (
    <Select
      value={appearance}
      onValueChange={(value) => {
        if (isAppearance(value)) setAppearance(value);
      }}
    >
      <SelectTrigger size="sm" aria-label="Appearance" className="w-[7.5rem]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="end">
        {APPEARANCES.map((option) => {
          const { label, icon: Icon } = APPEARANCE_OPTIONS[option];
          return (
            <SelectItem key={option} value={option}>
              <Icon aria-hidden="true" />
              {label}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

function SessionGate({
  state,
  onRetry,
}: {
  readonly state: Exclude<SessionState, { readonly kind: "ready" }>;
  readonly onRetry: () => void;
}): ReactNode {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-14 items-center justify-between border-b px-4 sm:px-6">
        <Wordmark />
        <AppearanceSelect />
      </header>
      <main id="main" className="flex flex-1 items-center justify-center p-6" aria-busy={state.kind === "loading"}>
        <SessionGateBody state={state} onRetry={onRetry} />
      </main>
    </div>
  );
}

function SessionGateBody({
  state,
  onRetry,
}: {
  readonly state: Exclude<SessionState, { readonly kind: "ready" }>;
  readonly onRetry: () => void;
}): ReactNode {
  switch (state.kind) {
    case "loading":
      return (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" />
          Checking session…
        </p>
      );
    case "expired":
      return (
        <div className="w-full max-w-sm space-y-4 text-center">
          <h1 className="text-lg font-semibold">Session ended</h1>
          <p className="text-sm text-muted-foreground">Sign in again to continue. Unsaved changes will be lost.</p>
          <Button onClick={() => window.location.reload()}>Sign in again</Button>
        </div>
      );
    case "failed":
      return (
        <div className="w-full max-w-sm space-y-4 text-center">
          <h1 className="text-lg font-semibold">Could not load the dashboard</h1>
          <p className="text-sm text-destructive" role="alert">
            {state.message}
          </p>
          <div className="flex justify-center gap-2">
            <Button onClick={onRetry}>Try again</Button>
            <Button variant="outline" asChild>
              <a href={LOGOUT_HREF}>Sign out</a>
            </Button>
          </div>
        </div>
      );
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

function NoticeRegion({ notice, onDismiss }: { readonly notice: Notice | null; readonly onDismiss: () => void }): ReactNode {
  // both regions stay mounted so screen readers register them before any message arrives
  return (
    <div className="pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex flex-col items-end gap-2 sm:left-auto sm:w-96">
      <div role="status" aria-live="polite" aria-atomic="true" className="w-full empty:hidden">
        {notice?.tone === "success" ? <NoticeCard key={notice.id} notice={notice} onDismiss={onDismiss} /> : null}
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="true" className="w-full empty:hidden">
        {notice?.tone === "error" ? <NoticeCard key={notice.id} notice={notice} onDismiss={onDismiss} /> : null}
      </div>
    </div>
  );
}

function NoticeCard({ notice, onDismiss }: { readonly notice: Notice; readonly onDismiss: () => void }): ReactNode {
  const Icon = notice.tone === "success" ? CircleCheckIcon : CircleAlertIcon;
  return (
    <div
      className={cn(
        "pointer-events-auto flex w-full items-start gap-3 rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-lg",
        notice.tone === "error" && "border-destructive/50",
      )}
    >
      <Icon
        className={cn("mt-0.5 size-4 shrink-0", notice.tone === "success" ? "text-primary" : "text-destructive")}
        aria-hidden="true"
      />
      <p className="min-w-0 flex-1 break-words">{notice.message}</p>
      <Button variant="ghost" size="icon-xs" onClick={onDismiss} aria-label="Dismiss message">
        <XIcon aria-hidden="true" />
      </Button>
    </div>
  );
}

function Workspace({
  session,
  announce,
  reportError,
}: {
  readonly session: Session;
  readonly announce: Announce;
  readonly reportError: ReportError;
}): ReactNode {
  const [searchInput, setSearchInput] = useState("");
  const search = useDebouncedValue(searchInput.trim(), SEARCH_DELAY_MILLISECONDS);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [listState, setListState] = useState<ListState>({ kind: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const [creating, setCreating] = useState(false);
  const [editingLink, setEditingLink] = useState<Link | null>(null);
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null);
  const [exporting, setExporting] = useState(false);
  const loadMoreController = useRef<AbortController | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchId = useId();

  const status = statusFilter === "all" ? null : statusFilter;
  const shortHost = hostOf(session.shortOrigin);

  useEffect(() => {
    const controller = new AbortController();
    loadMoreController.current?.abort();
    setListState({ kind: "loading" });
    fetchLinks({ search, status, cursor: null, signal: controller.signal })
      .then((page) => setListState({ kind: "ready", links: page.links, nextCursor: page.nextCursor, loadingMore: false }))
      .catch((error: unknown) => {
        if (isAbortError(error)) return;
        if (error instanceof SessionExpiredError) {
          reportError(error);
          return;
        }
        setListState({ kind: "failed", message: messageFromError(error) });
      });
    return () => controller.abort();
  }, [search, status, reloadToken, reportError]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent): void => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      if (document.querySelector('[role="dialog"], [role="listbox"]') !== null) return;
      event.preventDefault();
      searchInputRef.current?.focus();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  const loadMore = (): void => {
    if (listState.kind !== "ready" || listState.nextCursor === null || listState.loadingMore) return;
    const controller = new AbortController();
    loadMoreController.current = controller;
    const cursor = listState.nextCursor;
    setListState({ ...listState, loadingMore: true });
    fetchLinks({ search, status, cursor, signal: controller.signal })
      .then((page) => {
        setListState((current) => {
          if (current.kind !== "ready") return current;
          const known = new Set(current.links.map((link) => link.slug));
          return {
            kind: "ready",
            links: [...current.links, ...page.links.filter((link) => !known.has(link.slug))],
            nextCursor: page.nextCursor,
            loadingMore: false,
          };
        });
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) return;
        setListState((current) => (current.kind === "ready" ? { ...current, loadingMore: false } : current));
        reportError(error);
      });
  };

  const matchesFilter = (link: Link): boolean => status === null || link.status === status;

  const replaceLink = (updated: Link): void => {
    setListState((current) => {
      if (current.kind !== "ready") return current;
      return {
        ...current,
        links: matchesFilter(updated)
          ? current.links.map((link) => (link.slug === updated.slug ? updated : link))
          : current.links.filter((link) => link.slug !== updated.slug),
      };
    });
  };

  const removeLink = (slug: string): void => {
    setListState((current) =>
      current.kind === "ready" ? { ...current, links: current.links.filter((link) => link.slug !== slug) } : current,
    );
  };

  const handleCreated = (link: Link): void => {
    // only splice into the visible page when it would have appeared there anyway
    if (search === "" && matchesFilter(link)) {
      setListState((current) =>
        current.kind === "ready"
          ? { ...current, links: [link, ...current.links.filter((existing) => existing.slug !== link.slug)] }
          : current,
      );
    }
  };

  const restoreLink = async (link: Link): Promise<void> => {
    try {
      const updated = await updateLink({ slug: link.slug, changes: { status: "active" } });
      replaceLink(updated);
      announce({ tone: "success", message: `Restored ${shortHost}/${link.slug}.` });
    } catch (error) {
      reportError(error);
    }
  };

  const confirmPending = async (pending: PendingConfirmation): Promise<void> => {
    const address = `${shortHost}/${pending.link.slug}`;
    switch (pending.action) {
      case "revoke": {
        const updated = await updateLink({ slug: pending.link.slug, changes: { status: "revoked" } });
        replaceLink(updated);
        announce({ tone: "success", message: `Revoked ${address}.` });
        return;
      }
      case "delete": {
        await deleteLink(pending.link.slug);
        removeLink(pending.link.slug);
        announce({ tone: "success", message: `Deleted ${address}.` });
        return;
      }
      default: {
        const _exhaustive: never = pending.action;
        return _exhaustive;
      }
    }
  };

  const runExport = async (): Promise<void> => {
    setExporting(true);
    try {
      const links = await exportLinks();
      const blob = new Blob([JSON.stringify(links, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `ratatoskr-links-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // revoking straight away can cancel the download in some browsers
      window.setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_REVOKE_DELAY_MILLISECONDS);
      announce({ tone: "success", message: `Exported ${links.length} ${links.length === 1 ? "link" : "links"}.` });
    } catch (error) {
      reportError(error);
    } finally {
      setExporting(false);
    }
  };

  const actions: LinkActions = {
    onCopy: (link) =>
      void copyToClipboard({ text: redirectUrl({ session, slug: link.slug }), label: "short link", announce }),
    onCopyPreview: (link) =>
      void copyToClipboard({ text: previewUrl({ session, slug: link.slug }), label: "preview link", announce }),
    onEdit: setEditingLink,
    onRevoke: (link) => setConfirmation({ action: "revoke", link }),
    onRestore: (link) => void restoreLink(link),
    onDelete: (link) => setConfirmation({ action: "delete", link }),
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:px-6">
          <Wordmark />
          <span className="hidden font-mono text-xs text-muted-foreground sm:inline">{shortHost}</span>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden max-w-56 truncate text-sm text-muted-foreground md:inline" title={session.email}>
              {session.email}
            </span>
            <AppearanceSelect />
            <Button
              variant="outline"
              size="sm"
              onClick={() => void runExport()}
              disabled={exporting}
              aria-busy={exporting}
              aria-label="Export all links as JSON"
            >
              {exporting ? (
                <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
              ) : (
                <DownloadIcon aria-hidden="true" />
              )}
              <span className="hidden sm:inline">Export</span>
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <a href={LOGOUT_HREF} aria-label="Sign out">
                <LogOutIcon aria-hidden="true" />
                <span className="hidden sm:inline">Sign out</span>
              </a>
            </Button>
          </div>
        </div>
      </header>

      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-7xl flex-1 space-y-4 px-4 py-6 outline-none sm:px-6">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Links</h1>
          <ListSummary state={listState} />
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1 sm:max-w-sm">
            <Label htmlFor={searchId} className="sr-only">
              Search links
            </Label>
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              ref={searchInputRef}
              id={searchId}
              type="search"
              placeholder="Search slug, title or destination"
              className="pl-8"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-keyshortcuts="/"
            />
          </div>
          <div className="flex gap-2">
            <Select
              value={statusFilter}
              onValueChange={(value) => {
                if (isStatusFilter(value)) setStatusFilter(value);
              }}
            >
              <SelectTrigger aria-label="Filter by status" className="w-full sm:w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {STATUS_FILTERS.map((filter) => (
                  <SelectItem key={filter} value={filter}>
                    {STATUS_FILTER_LABELS[filter]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button className="shrink-0 sm:ml-auto" onClick={() => setCreating(true)}>
              <PlusIcon aria-hidden="true" />
              New link
            </Button>
          </div>
        </div>

        <LinkList
          state={listState}
          session={session}
          search={search}
          statusFilter={statusFilter}
          actions={actions}
          onRetry={() => setReloadToken((token) => token + 1)}
          onLoadMore={loadMore}
        />
      </main>

      <CreateDialog
        open={creating}
        session={session}
        announce={announce}
        onOpenChange={setCreating}
        onCreated={handleCreated}
        onSessionExpired={reportError}
      />

      <Dialog
        open={editingLink !== null}
        onOpenChange={(open) => {
          if (!open) setEditingLink(null);
        }}
      >
        {editingLink !== null ? (
          <EditDialogContent
            key={editingLink.slug}
            link={editingLink}
            session={session}
            onClose={() => setEditingLink(null)}
            onSaved={(updated) => {
              replaceLink(updated);
              setEditingLink(null);
              announce({ tone: "success", message: `Saved ${shortHost}/${updated.slug}.` });
            }}
            onSessionExpired={reportError}
          />
        ) : null}
      </Dialog>

      <Dialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        {confirmation !== null ? (
          <ConfirmDialogContent
            key={`${confirmation.action}-${confirmation.link.slug}`}
            pending={confirmation}
            session={session}
            onClose={() => setConfirmation(null)}
            onConfirm={async () => {
              await confirmPending(confirmation);
              setConfirmation(null);
            }}
            onSessionExpired={reportError}
          />
        ) : null}
      </Dialog>
    </div>
  );
}

function ListSummary({ state }: { readonly state: ListState }): ReactNode {
  if (state.kind !== "ready") return null;
  const count = state.links.length;
  const more = state.nextCursor === null ? "" : "+";
  return (
    <p className="text-sm text-muted-foreground tabular-nums">
      {count}
      {more} {count === 1 && more === "" ? "link" : "links"}
    </p>
  );
}

function LinkList({
  state,
  session,
  search,
  statusFilter,
  actions,
  onRetry,
  onLoadMore,
}: {
  readonly state: ListState;
  readonly session: Session;
  readonly search: string;
  readonly statusFilter: StatusFilter;
  readonly actions: LinkActions;
  readonly onRetry: () => void;
  readonly onLoadMore: () => void;
}): ReactNode {
  switch (state.kind) {
    case "loading":
      return (
        <ListPlaceholder busy>
          <p className="flex items-center gap-2" role="status">
            <LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" />
            Loading links…
          </p>
        </ListPlaceholder>
      );
    case "failed":
      return (
        <ListPlaceholder>
          <p className="text-destructive" role="alert">
            {state.message}
          </p>
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </ListPlaceholder>
      );
    case "ready":
      if (state.links.length === 0) {
        return (
          <ListPlaceholder>
            <p>{emptyMessage({ search, statusFilter })}</p>
          </ListPlaceholder>
        );
      }
      return (
        <div className="space-y-4">
          <LinkTable links={state.links} session={session} actions={actions} />
          <LinkCards links={state.links} session={session} actions={actions} />
          {state.nextCursor !== null ? (
            <div className="flex justify-center">
              <Button variant="outline" onClick={onLoadMore} disabled={state.loadingMore} aria-busy={state.loadingMore}>
                {state.loadingMore ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : null}
                {state.loadingMore ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : null}
        </div>
      );
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

function ListPlaceholder({ busy = false, children }: { readonly busy?: boolean; readonly children: ReactNode }): ReactNode {
  return (
    <div
      className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground"
      aria-busy={busy}
    >
      {children}
    </div>
  );
}

function emptyMessage({ search, statusFilter }: { readonly search: string; readonly statusFilter: StatusFilter }): string {
  if (search !== "") return `No links match “${search}”.`;
  switch (statusFilter) {
    case "all":
      return "No links yet.";
    case "active":
      return "No active links.";
    case "revoked":
      return "No revoked links.";
    default: {
      const _exhaustive: never = statusFilter;
      return _exhaustive;
    }
  }
}

function LinkTable({
  links,
  session,
  actions,
}: {
  readonly links: readonly Link[];
  readonly session: Session;
  readonly actions: LinkActions;
}): ReactNode {
  return (
    <div className="hidden rounded-lg border md:block">
      <Table className="table-fixed">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-[24%] px-4">Short link</TableHead>
            <TableHead>Destination</TableHead>
            <TableHead className="w-24">Status</TableHead>
            <TableHead className="w-44">Expires</TableHead>
            <TableHead className="w-28">Created</TableHead>
            <TableHead className="w-44 px-4 text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {links.map((link) => {
            const url = redirectUrl({ session, slug: link.slug });
            return (
              <TableRow key={link.slug} className={cn(link.status === "revoked" && "text-muted-foreground")}>
                <TableCell className="px-4">
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="block truncate font-mono text-[13px] font-medium text-primary hover:underline"
                  >
                    {withoutScheme(url)}
                  </a>
                  {link.title !== "" ? (
                    <span className="block truncate text-xs text-muted-foreground" title={link.title}>
                      {link.title}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell>
                  <a
                    href={link.destination}
                    target="_blank"
                    rel="noreferrer"
                    title={link.destination}
                    className="block truncate font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
                  >
                    {link.destination}
                  </a>
                </TableCell>
                <TableCell>
                  <StatusBadge link={link} />
                </TableCell>
                <TableCell>
                  <ExpiryText link={link} />
                </TableCell>
                <TableCell className="text-muted-foreground tabular-nums">
                  <time dateTime={link.createdAt}>{formatDate(link.createdAt, dateFormat)}</time>
                </TableCell>
                <TableCell className="px-4">
                  <RowActions link={link} actions={actions} className="justify-end" />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function LinkCards({
  links,
  session,
  actions,
}: {
  readonly links: readonly Link[];
  readonly session: Session;
  readonly actions: LinkActions;
}): ReactNode {
  return (
    <ul className="divide-y rounded-lg border md:hidden">
      {links.map((link) => {
        const url = redirectUrl({ session, slug: link.slug });
        return (
          <li key={link.slug} className="space-y-2 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="block truncate font-mono text-sm font-medium text-primary hover:underline"
                >
                  {withoutScheme(url)}
                </a>
                {link.title !== "" ? <p className="truncate text-sm">{link.title}</p> : null}
              </div>
              <StatusBadge link={link} />
            </div>
            <a
              href={link.destination}
              target="_blank"
              rel="noreferrer"
              className="block truncate font-mono text-xs text-muted-foreground hover:underline"
            >
              <span className="sr-only">Destination: </span>
              {link.destination}
            </a>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>
                Created <time dateTime={link.createdAt}>{formatDate(link.createdAt, dateFormat)}</time>
              </span>
              {link.expiresAt !== null ? (
                <span>
                  <ExpiryText link={link} withLabel />
                </span>
              ) : null}
            </div>
            <RowActions link={link} actions={actions} className="-ml-2" />
          </li>
        );
      })}
    </ul>
  );
}

function ExpiryText({ link, withLabel = false }: { readonly link: Link; readonly withLabel?: boolean }): ReactNode {
  if (link.expiresAt === null) return <span className="text-muted-foreground">Never</span>;
  const expired = isExpired(link);
  return (
    <span className={cn("tabular-nums", expired ? "text-warning" : "text-muted-foreground")}>
      {withLabel || expired ? (expired ? "Expired " : "Expires ") : null}
      <time dateTime={link.expiresAt}>{formatDate(link.expiresAt, dateTimeFormat)}</time>
    </span>
  );
}

function StatusBadge({ link }: { readonly link: Link }): ReactNode {
  if (link.status === "revoked") return <Badge variant="secondary">Revoked</Badge>;
  if (isExpired(link)) {
    return (
      <Badge variant="outline" className="border-warning/40 text-warning">
        Expired
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1.5">
      <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
      Active
    </Badge>
  );
}

function RowActions({
  link,
  actions,
  className,
}: {
  readonly link: Link;
  readonly actions: LinkActions;
  readonly className?: string;
}): ReactNode {
  return (
    <div className={cn("flex items-center gap-0.5", className)} role="group" aria-label={`Actions for ${link.slug}`}>
      <IconAction label={`Copy short link for ${link.slug}`} icon={CopyIcon} onClick={() => actions.onCopy(link)} />
      <IconAction
        label={`Copy preview link for ${link.slug}`}
        icon={EyeIcon}
        onClick={() => actions.onCopyPreview(link)}
      />
      <IconAction label={`Edit ${link.slug}`} icon={PencilIcon} onClick={() => actions.onEdit(link)} />
      {link.status === "active" ? (
        <IconAction label={`Revoke ${link.slug}`} icon={BanIcon} onClick={() => actions.onRevoke(link)} />
      ) : (
        <IconAction label={`Restore ${link.slug}`} icon={RotateCcwIcon} onClick={() => actions.onRestore(link)} />
      )}
      <IconAction
        label={`Delete ${link.slug}`}
        icon={Trash2Icon}
        onClick={() => actions.onDelete(link)}
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
      />
    </div>
  );
}

function IconAction({
  label,
  icon: Icon,
  onClick,
  className,
}: {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly onClick: () => void;
  readonly className?: string;
}): ReactNode {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn("text-muted-foreground hover:text-foreground", className)}
    >
      <Icon aria-hidden="true" />
    </Button>
  );
}

function FormError({ id, message }: { readonly id: string; readonly message: string | null }): ReactNode {
  if (message === null) return null;
  return (
    <p
      id={id}
      role="alert"
      className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      {message}
    </p>
  );
}

function Field({
  id,
  label,
  optional = false,
  hint,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly optional?: boolean;
  readonly hint?: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>
        {label}
        {optional ? <span className="font-normal text-muted-foreground">(optional)</span> : null}
      </Label>
      {children}
      {hint !== undefined ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

// radix closes on escape, outside clicks and the close button; all three must wait for an in-flight request
function busyGuards(busy: boolean): {
  readonly showCloseButton: boolean;
  readonly onEscapeKeyDown: (event: Event) => void;
  readonly onInteractOutside: (event: Event) => void;
} {
  const guard = (event: Event): void => {
    if (busy) event.preventDefault();
  };
  return { showCloseButton: !busy, onEscapeKeyDown: guard, onInteractOutside: guard };
}

function CreateDialog({
  open,
  session,
  announce,
  onOpenChange,
  onCreated,
  onSessionExpired,
}: {
  readonly open: boolean;
  readonly session: Session;
  readonly announce: Announce;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: (link: Link) => void;
  readonly onSessionExpired: ReportError;
}): ReactNode {
  const [formKey, setFormKey] = useState(0);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <CreateDialogContent
          key={formKey}
          session={session}
          announce={announce}
          onClose={() => onOpenChange(false)}
          onReset={() => setFormKey((key) => key + 1)}
          onCreated={onCreated}
          onSessionExpired={onSessionExpired}
        />
      ) : null}
    </Dialog>
  );
}

function CreateDialogContent({
  session,
  announce,
  onClose,
  onReset,
  onCreated,
  onSessionExpired,
}: {
  readonly session: Session;
  readonly announce: Announce;
  readonly onClose: () => void;
  readonly onReset: () => void;
  readonly onCreated: (link: Link) => void;
  readonly onSessionExpired: ReportError;
}): ReactNode {
  const [destination, setDestination] = useState("");
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [expiry, setExpiry] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<Link | null>(null);
  const fieldId = useId();
  const errorId = `${fieldId}-error`;
  const shortHost = hostOf(session.shortOrigin);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    setFormError(null);

    const parsedExpiry = parseExpiryInput(expiry);
    if (parsedExpiry.kind === "invalid") {
      setFormError(parsedExpiry.message);
      return;
    }
    const customSlug = slug.trim().toLowerCase();
    const parsed = createLinkSchema.safeParse({
      destination,
      title,
      ...(customSlug === "" ? {} : { slug: customSlug }),
      ...(parsedExpiry.kind === "valid" ? { expiresAt: parsedExpiry.iso } : {}),
    });
    if (!parsed.success) {
      setFormError(describeValidationError(parsed.error));
      return;
    }

    setSubmitting(true);
    try {
      const link = await createLink(parsed.data);
      onCreated(link);
      setCreated(link);
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        onSessionExpired(error);
        return;
      }
      setFormError(messageFromError(error));
    } finally {
      setSubmitting(false);
    }
  };

  if (created !== null) {
    const url = redirectUrl({ session, slug: created.slug });
    const preview = previewUrl({ session, slug: created.slug });
    return (
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link created</DialogTitle>
          <DialogDescription className="sr-only">The new short link is ready to copy.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <CopyRow value={url} label="short link" announce={announce} />
          <CopyRow value={preview} label="preview link" announce={announce} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onReset}>
            Create another
          </Button>
          <Button onClick={onClose} autoFocus>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    );
  }

  return (
    <DialogContent {...busyGuards(submitting)} aria-describedby={undefined}>
      <form className="grid gap-4" onSubmit={(event) => void submit(event)} noValidate>
        <DialogHeader>
          <DialogTitle>New link</DialogTitle>
        </DialogHeader>

        <Field id={`${fieldId}-destination`} label="Destination">
          <Input
            id={`${fieldId}-destination`}
            type="url"
            inputMode="url"
            required
            autoFocus
            maxLength={MAXIMUM_DESTINATION_LENGTH}
            placeholder="https://"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
          />
        </Field>

        <Field id={`${fieldId}-title`} label="Title" optional>
          <Input
            id={`${fieldId}-title`}
            type="text"
            maxLength={MAXIMUM_TITLE_LENGTH}
            autoComplete="off"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>

        <Field
          id={`${fieldId}-slug`}
          label="Slug"
          optional
          hint="Leave empty to generate one. Deleted slugs are never reused."
        >
          <div className="flex rounded-md shadow-xs focus-within:ring-[3px] focus-within:ring-ring/50">
            <span
              className="inline-flex items-center rounded-l-md border border-r-0 border-input bg-muted px-3 font-mono text-sm text-muted-foreground"
              aria-hidden="true"
            >
              {shortHost}/
            </span>
            <Input
              id={`${fieldId}-slug`}
              type="text"
              maxLength={MAXIMUM_CUSTOM_SLUG_LENGTH}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              aria-describedby={`${fieldId}-slug-hint`}
              className="rounded-l-none font-mono shadow-none focus-visible:ring-0"
              value={slug}
              onChange={(event) => setSlug(event.target.value.toLowerCase())}
            />
          </div>
        </Field>

        <Field id={`${fieldId}-expiry`} label="Expires" optional hint="Local time.">
          <Input
            id={`${fieldId}-expiry`}
            type="datetime-local"
            min={minimumExpiryInputValue()}
            aria-describedby={`${fieldId}-expiry-hint`}
            value={expiry}
            onChange={(event) => setExpiry(event.target.value)}
          />
        </Field>

        <FormError id={errorId} message={formError} />

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting} aria-busy={submitting}>
            {submitting ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : null}
            {submitting ? "Creating…" : "Create link"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function CopyRow({
  value,
  label,
  announce,
}: {
  readonly value: string;
  readonly label: string;
  readonly announce: Announce;
}): ReactNode {
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/40 py-1 pr-1 pl-3">
      <a
        href={value}
        target="_blank"
        rel="noreferrer"
        className="min-w-0 flex-1 truncate font-mono text-sm text-primary hover:underline"
      >
        {withoutScheme(value)}
      </a>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => void copyToClipboard({ text: value, label, announce })}
        aria-label={`Copy ${label}`}
      >
        <CopyIcon aria-hidden="true" />
        Copy
      </Button>
    </div>
  );
}

function EditDialogContent({
  link,
  session,
  onClose,
  onSaved,
  onSessionExpired,
}: {
  readonly link: Link;
  readonly session: Session;
  readonly onClose: () => void;
  readonly onSaved: (link: Link) => void;
  readonly onSessionExpired: ReportError;
}): ReactNode {
  const initialExpiry = toLocalInputValue(link.expiresAt);
  const [destination, setDestination] = useState(link.destination);
  const [title, setTitle] = useState(link.title);
  const [expiry, setExpiry] = useState(initialExpiry);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const fieldId = useId();
  const errorId = `${fieldId}-error`;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (saving) return;
    setFormError(null);

    const expiryChanged = expiry !== initialExpiry;
    const parsedExpiry = expiryChanged ? parseExpiryInput(expiry) : null;
    if (parsedExpiry?.kind === "invalid") {
      setFormError(parsedExpiry.message);
      return;
    }

    const candidate = {
      ...(destination.trim() === link.destination ? {} : { destination }),
      ...(title.trim() === link.title ? {} : { title }),
      ...(parsedExpiry === null ? {} : { expiresAt: parsedExpiry.kind === "valid" ? parsedExpiry.iso : null }),
    };
    if (Object.keys(candidate).length === 0) {
      onClose();
      return;
    }
    const parsed = updateLinkSchema.safeParse(candidate);
    if (!parsed.success) {
      setFormError(describeValidationError(parsed.error));
      return;
    }
    const changes: UpdateLink = parsed.data;

    setSaving(true);
    try {
      onSaved(await updateLink({ slug: link.slug, changes }));
    } catch (error) {
      setSaving(false);
      if (error instanceof SessionExpiredError) {
        onSessionExpired(error);
        return;
      }
      setFormError(messageFromError(error));
    }
  };

  return (
    <DialogContent {...busyGuards(saving)}>
      <form className="grid gap-4" onSubmit={(event) => void submit(event)} noValidate>
        <DialogHeader>
          <DialogTitle>Edit link</DialogTitle>
          <DialogDescription className="font-mono">
            {withoutScheme(redirectUrl({ session, slug: link.slug }))}
          </DialogDescription>
        </DialogHeader>

        <Field id={`${fieldId}-destination`} label="Destination">
          <Input
            id={`${fieldId}-destination`}
            type="url"
            inputMode="url"
            required
            maxLength={MAXIMUM_DESTINATION_LENGTH}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
          />
        </Field>

        <Field id={`${fieldId}-title`} label="Title" optional>
          <Input
            id={`${fieldId}-title`}
            type="text"
            maxLength={MAXIMUM_TITLE_LENGTH}
            autoComplete="off"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>

        <Field id={`${fieldId}-expiry`} label="Expires" optional hint="Local time. Clear to never expire.">
          <div className="flex gap-2">
            <Input
              id={`${fieldId}-expiry`}
              type="datetime-local"
              min={minimumExpiryInputValue()}
              aria-describedby={`${fieldId}-expiry-hint`}
              value={expiry}
              onChange={(event) => setExpiry(event.target.value)}
            />
            <Button type="button" variant="outline" onClick={() => setExpiry("")} disabled={expiry === ""}>
              Clear
            </Button>
          </div>
        </Field>

        <FormError id={errorId} message={formError} />

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving} aria-busy={saving}>
            {saving ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : null}
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function ConfirmDialogContent({
  pending,
  session,
  onClose,
  onConfirm,
  onSessionExpired,
}: {
  readonly pending: PendingConfirmation;
  readonly session: Session;
  readonly onClose: () => void;
  readonly onConfirm: () => Promise<void>;
  readonly onSessionExpired: ReportError;
}): ReactNode {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const address = withoutScheme(redirectUrl({ session, slug: pending.link.slug }));
  const copy = confirmationCopy(pending.action);

  const confirm = async (): Promise<void> => {
    setWorking(true);
    setError(null);
    try {
      await onConfirm();
    } catch (caught) {
      setWorking(false);
      if (caught instanceof SessionExpiredError) {
        onSessionExpired(caught);
        return;
      }
      setError(messageFromError(caught));
    }
  };

  return (
    <DialogContent {...busyGuards(working)} className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription>
          <span className="font-mono text-foreground">{address}</span> {copy.body}
        </DialogDescription>
      </DialogHeader>
      <FormError id={errorId} message={error} />
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={working} autoFocus>
          Cancel
        </Button>
        <Button
          variant={pending.action === "delete" ? "destructive" : "default"}
          onClick={() => void confirm()}
          disabled={working}
          aria-busy={working}
        >
          {working ? <LoaderCircleIcon className="animate-spin" aria-hidden="true" /> : null}
          {working ? copy.workingLabel : copy.confirmLabel}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function confirmationCopy(action: PendingConfirmation["action"]): {
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly workingLabel: string;
} {
  switch (action) {
    case "revoke":
      return {
        title: "Revoke link?",
        body: "will stop redirecting. You can restore it later.",
        confirmLabel: "Revoke",
        workingLabel: "Revoking…",
      };
    case "delete":
      return {
        title: "Delete link?",
        body: "will be removed permanently and the slug will never be reissued. This cannot be undone.",
        confirmLabel: "Delete",
        workingLabel: "Deleting…",
      };
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

applyStoredAppearance();

const rootElement = document.getElementById("root");
if (rootElement !== null) {
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
