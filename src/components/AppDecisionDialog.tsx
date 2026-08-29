import { createSignal, type Component } from 'solid-js';
import { t } from '../i18n';
import { useModalFocus } from './modalFocus';

interface TextInputOptions {
  label: string;
  initialValue: string;
  placeholder?: string;
  maxLength?: number;
}

interface Props {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  input?: TextInputOptions;
  onResolve: (accepted: boolean, value: string) => void;
}

const AppDecisionDialog: Component<Props> = (props) => {
  let dialogRef: HTMLFormElement | undefined;
  const [value, setValue] = createSignal(props.input?.initialValue ?? '');
  const valid = () => !props.input || value().trim().length > 0;
  const cancel = () => props.onResolve(false, value());
  const confirm = () => {
    if (!valid()) return;
    props.onResolve(true, props.input ? value().trim() : value());
  };
  useModalFocus(() => dialogRef);

  return <div class="modal-overlay app-decision-overlay" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) cancel(); }}>
    <form
      ref={dialogRef}
      class="modal app-decision-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="app-decision-title"
      aria-describedby="app-decision-message"
      tabindex="-1"
      onSubmit={(event) => { event.preventDefault(); confirm(); }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }}
    >
      <h3 id="app-decision-title">{props.title}</h3>
      <p id="app-decision-message">{props.message}</p>
      {props.input ? <label class="app-decision-field">
        <span>{props.input.label}</span>
        <input
          class="text-input"
          value={value()}
          placeholder={props.input.placeholder}
          maxlength={props.input.maxLength ?? 96}
          autofocus
          onInput={(event) => setValue(event.currentTarget.value)}
        />
      </label> : null}
      <div class="modal-actions">
        <button class="btn" type="button" autofocus={!props.input} onClick={cancel}>{props.cancelLabel ?? t('decision.cancel')}</button>
        <button class={`btn ${props.danger ? 'danger' : 'primary'}`} type="submit" disabled={!valid()}>{props.confirmLabel ?? t('decision.confirm')}</button>
      </div>
    </form>
  </div>;
};

export default AppDecisionDialog;
