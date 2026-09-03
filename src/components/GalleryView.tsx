import { For, Show, createSignal, onCleanup, onMount, type Component } from 'solid-js';
import { t } from '../i18n';
import { useModalFocus } from './modalFocus';
import { readThumbnailDataUrl } from '../project/library';
import type { LibraryEntryInfo } from '../project/bridge';

interface CardProps {
  entry: LibraryEntryInfo;
  onOpen: (entry: LibraryEntryInfo) => void;
  onDelete: (entry: LibraryEntryInfo) => void;
  onReveal: (entry: LibraryEntryInfo) => void;
}

function formatModified(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const diff = Date.now() - then;
  if (diff < 60_000) return t('gallery.time.justNow');
  if (diff < 3_600_000) return t('gallery.time.minutes', { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('gallery.time.hours', { n: Math.floor(diff / 3_600_000) });
  if (diff < 604_800_000) return t('gallery.time.days', { n: Math.floor(diff / 86_400_000) });
  return new Date(then).toLocaleString();
}

const GalleryCard: Component<CardProps> = (props) => {
  const [thumb, setThumb] = createSignal<string | null>(null);
  const [menuOpen, setMenuOpen] = createSignal(false);
  let anchorRef: HTMLDivElement | undefined;
  const initial = () => (props.entry.name.trim()[0] ?? '?').toUpperCase();

  void readThumbnailDataUrl(props.entry.dir).then(setThumb);

  onMount(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!menuOpen()) return;
      if (anchorRef && !anchorRef.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    onCleanup(() => document.removeEventListener('pointerdown', onPointerDown));
  });

  return (
    <article class="gallery-card">
      <button
        class="gallery-thumb"
        title={t('gallery.open')}
        onClick={() => props.onOpen(props.entry)}
      >
        <Show
          when={thumb()}
          fallback={<span class="gallery-thumb-fallback">{initial()}</span>}
        >
          <img src={thumb()!} alt={props.entry.name} loading="lazy" />
        </Show>
      </button>
      <div class="gallery-row">
        <div class="gallery-meta">
          <button
            class="gallery-name"
            title={props.entry.name}
            onClick={() => props.onOpen(props.entry)}
          >{props.entry.name}</button>
          <span class="gallery-time">{formatModified(props.entry.modified)}</span>
        </div>
        <div class="gallery-menu-anchor" ref={anchorRef}>
          <button
            class="gallery-icon-btn"
            aria-haspopup="menu"
            aria-expanded={menuOpen()}
            aria-label={t('gallery.more')}
            title={t('gallery.more')}
            onClick={() => setMenuOpen(!menuOpen())}
          >⋯</button>
          <Show when={menuOpen()}>
            <div class="gallery-menu" role="menu">
              <button role="menuitem" onClick={() => { setMenuOpen(false); props.onOpen(props.entry); }}>{t('gallery.open')}</button>
              <button role="menuitem" onClick={() => { setMenuOpen(false); props.onReveal(props.entry); }}>{t('gallery.reveal')}</button>
              <button role="menuitem" class="danger" onClick={() => { setMenuOpen(false); props.onDelete(props.entry); }}>{t('common.delete')}</button>
            </div>
          </Show>
        </div>
      </div>
    </article>
  );
};

interface Props {
  entries: LibraryEntryInfo[];
  loading: boolean;
  error: string | null;
  onOpen: (entry: LibraryEntryInfo) => void;
  onDelete: (entry: LibraryEntryInfo) => void;
  onReveal: (entry: LibraryEntryInfo) => void;
  onNewProject: () => void;
  onClose: () => void;
}

const GalleryView: Component<Props> = (props) => {
  let dialogRef: HTMLDivElement | undefined;
  useModalFocus(() => dialogRef);

  return (
    <div
      class="modal-overlay gallery-overlay"
      role="presentation"
      onPointerDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}
    >
      <div
        ref={dialogRef}
        class="gallery-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gallery-title"
        tabindex="-1"
      >
        <header class="gallery-header">
          <div>
            <h3 id="gallery-title">{t('gallery.title')}</h3>
            <p class="gallery-subtitle">{t('gallery.subtitle')}</p>
          </div>
          <button
            class="gallery-icon-btn"
            aria-label={t('common.close')}
            title={t('common.close')}
            onClick={props.onClose}
          >✕</button>
        </header>
        <div class="gallery-body">
          <Show when={!props.loading} fallback={<div class="gallery-state">{t('gallery.loading')}</div>}>
            <Show
              when={!props.error}
              fallback={<div class="gallery-state gallery-state-error">{t('gallery.error', { detail: props.error ?? '' })}</div>}
            >
              <Show
                when={props.entries.length > 0}
                fallback={
                  <div class="gallery-state gallery-state-empty">
                    <p>{t('gallery.empty')}</p>
                    <button class="btn primary" onClick={props.onNewProject}>{t('app.menu.newProject')}</button>
                  </div>
                }
              >
                <div class="gallery-grid">
                  <For each={props.entries}>
                    {(entry) => (
                      <GalleryCard
                        entry={entry}
                        onOpen={props.onOpen}
                        onDelete={props.onDelete}
                        onReveal={props.onReveal}
                      />
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </Show>
        </div>
        <footer class="gallery-footer">
          <button class="btn primary gallery-new" onClick={props.onNewProject}>{t('app.menu.newProject')}</button>
          <button class="btn" onClick={props.onClose}>{t('common.close')}</button>
        </footer>
      </div>
    </div>
  );
};

export default GalleryView;
