/* TemplatesDialog.tsx — modal gallery of starter templates.
 *
 * Click a template → opens the editor with that route as a new tab.
 */

import s from "./templates.module.css";
import { TEMPLATES, type Template } from "../../data/templates";

type Props = {
  open: boolean;
  onClose: () => void;
  onPick: (t: Template) => void;
};

export function TemplatesDialog({ open, onClose, onPick }: Props) {
  if (!open) return null;
  return (
    <div className={s.backdrop} onClick={onClose}>
      <div className={s.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={s.head}>
          <b>New from template</b>
          <button className={s.close} onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className={s.grid}>
          {TEMPLATES.map((t) => (
            <button key={t.id} className={s.card} onClick={() => onPick(t)}>
              <div
                className={s.thumb}
                style={t.thumbnail ? { backgroundImage: `url("${t.thumbnail}")` } : undefined}
              />
              <div className={s.body}>
                <div className={s.label}>{t.label}</div>
                <div className={s.desc}>{t.description}</div>
                <code className={s.route}>{t.route}</code>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
