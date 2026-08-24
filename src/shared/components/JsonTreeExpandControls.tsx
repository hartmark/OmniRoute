"use client";

import { useTranslations } from "next-intl";
import useJsonTreeExpandStore from "@/store/jsonTreeExpandStore";

// Shared collapse/expand-depth controls for every JSON tree box (PayloadSection,
// StreamSection). The level is one global, localStorage-persisted setting (see
// jsonTreeExpandStore) so it carries across page refreshes and between
// different requests, and stays in sync live across every box mounted on the
// same page at once.
export function JsonTreeExpandControls() {
  const t = useTranslations("requestLogger.detail");
  const { level, collapseAll, collapseOneLevel, expandOneLevel, expandAll } =
    useJsonTreeExpandStore();

  const buttonClass =
    "p-1 rounded hover:bg-bg-subtle text-text-muted hover:text-text-primary transition-colors";

  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        onClick={collapseAll}
        title={t("collapseAllLevels")}
        aria-label={t("collapseAllLevels")}
        className={buttonClass}
      >
        <span className="material-symbols-outlined text-[16px]">collapse_all</span>
      </button>
      <button
        type="button"
        onClick={collapseOneLevel}
        title={t("collapseOneLevel")}
        aria-label={t("collapseOneLevel")}
        className={buttonClass}
      >
        <span className="material-symbols-outlined text-[16px]">remove</span>
      </button>
      <span
        className="min-w-[1.5em] text-center text-[11px] font-mono text-text-muted tabular-nums"
        title={t("currentExpandLevel")}
      >
        {level}
      </span>
      <button
        type="button"
        onClick={expandOneLevel}
        title={t("expandOneLevel")}
        aria-label={t("expandOneLevel")}
        className={buttonClass}
      >
        <span className="material-symbols-outlined text-[16px]">add</span>
      </button>
      <button
        type="button"
        onClick={expandAll}
        title={t("expandAllLevels")}
        aria-label={t("expandAllLevels")}
        className={buttonClass}
      >
        <span className="material-symbols-outlined text-[16px]">expand_all</span>
      </button>
    </div>
  );
}
