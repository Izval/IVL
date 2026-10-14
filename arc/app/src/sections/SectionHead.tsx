import type { ReactNode } from "react";

/** Section title block: a full rule, the headline, and its lede beside it. */
export function SectionHead({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <header className="sh" data-reveal="stagger">
      <h2>{title}</h2>
      {children && <p className="sh-lede">{children}</p>}
    </header>
  );
}
