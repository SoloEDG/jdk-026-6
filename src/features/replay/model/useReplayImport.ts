import { useCallback, useState } from "react";
import type { Puzzle } from "../../../shared/types";
import {
  IMPORT_ERROR_TEXT,
  parseReplayText,
  validateBundle,
  type ReplayBundle,
  type ReplayImportError,
} from "./bundle";

export interface ImportedReplay {
  bundle: ReplayBundle;
  puzzle: Puzzle;
}

export function useReplayImport(puzzles: Puzzle[]) {
  const [error, setError] = useState<{ code: ReplayImportError; detail?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const importFile = useCallback(
    (file: File | undefined): Promise<ImportedReplay | null> => {
      if (!file) {
        setError({ code: "cancelled" });
        return Promise.resolve(null);
      }
      setBusy(true);
      return file
        .text()
        .then((text) => {
          let parsed: unknown;
          try {
            parsed = parseReplayText(text);
          } catch {
            setError({ code: "unreadable" });
            return null;
          }
          const result = validateBundle(parsed, puzzles);
          if (!result.ok) {
            setError({ code: result.error, detail: result.detail });
            return null;
          }
          setError(null);
          return { bundle: result.bundle, puzzle: result.puzzle };
        })
        .catch(() => {
          setError({ code: "unreadable" });
          return null;
        })
        .finally(() => setBusy(false));
    },
    [puzzles],
  );

  const pickFile = useCallback((): Promise<ImportedReplay | null> => {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json,.html,application/json,text/html";
      input.onchange = () => {
        importFile(input.files?.[0]).then(resolve);
      };
      input.click();
    });
  }, [importFile]);

  return { error, busy, pickFile, clearError: () => setError(null), errorText: error ? IMPORT_ERROR_TEXT[error.code] : "" };
}
