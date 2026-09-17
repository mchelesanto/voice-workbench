"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { LIMITS } from "../shared/contracts";
import {
  commitVocabulary,
  hasPendingVocabulary,
  pasteVocabulary,
  sortedVocabulary,
  type VocabularyInput,
} from "./vocabulary-input";

export function VocabularyEditor({
  value,
  onChange,
  disabled = false,
  label = "Global vocabulary",
}: {
  value: VocabularyInput;
  onChange: (value: VocabularyInput) => void;
  disabled?: boolean;
  label?: string;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [overflow, setOverflow] = useState(false);
  const composing = useRef(false);
  useEffect(() => {
    const element = list.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setOverflow(element.scrollHeight > element.clientHeight + 1),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [value.terms]);
  function add(text = value.pending) {
    if (disabled || composing.current) return;
    onChange(commitVocabulary(value.terms, text));
    input.current?.focus();
  }
  return (
    <section className="vocabulary-field" aria-labelledby={`${id}-label`}>
      <div className="vocabulary-heading">
        <label id={`${id}-label`} htmlFor={id}>
          {label}
        </label>
        <span>
          {value.terms.length} / {LIMITS.maxVocabularyTerms} terms{" "}
          <span aria-hidden="true">·</span> Sorted A to Z
        </span>
      </div>
      <div className={`vocabulary-editor ${value.error ? "has-error" : ""}`}>
        {value.terms.length ? (
          <ul
            ref={list}
            className="vocabulary-tags"
            aria-label={`${label} terms`}
            aria-describedby={overflow ? `${id}-scroll` : undefined}
          >
            {sortedVocabulary(value.terms).map((term) => (
              <li key={term}>
                <span>{term}</span>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Remove ${term}`}
                  onClick={() => {
                    onChange({
                      ...value,
                      terms: value.terms.filter((item) => item !== term),
                      announcement: `Removed ${term}.`,
                    });
                    input.current?.focus();
                  }}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="vocabulary-empty">
            A place for names, projects and specialist terms.
          </p>
        )}
        {value.terms.length > 0 && overflow && (
          <p id={`${id}-scroll`} className="vocabulary-scroll-hint">
            Scroll to see all {value.terms.length} terms.
          </p>
        )}
        <div className="vocabulary-add">
          <input
            id={id}
            ref={input}
            autoFocus
            value={value.pending}
            disabled={disabled}
            aria-label="Add a word or phrase"
            placeholder="Add a word or phrase"
            aria-describedby={`${id}-hint${value.error ? ` ${id}-error` : ""}`}
            aria-invalid={!!value.error}
            autoComplete="off"
            onChange={(event) =>
              onChange({
                ...value,
                pending: event.target.value,
                error: "",
                announcement: "",
              })
            }
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(event) => {
              if (
                composing.current ||
                event.nativeEvent.isComposing ||
                event.keyCode === 229
              )
                return;
              if (event.key === "Enter" || event.key === ",") {
                event.preventDefault();
                add();
              }
            }}
            onPaste={(event) => {
              const text = event.clipboardData.getData("text");
              if (composing.current || !/[\r\n,\t]/u.test(text)) return;
              event.preventDefault();
              add(
                pasteVocabulary(
                  value.pending,
                  text,
                  event.currentTarget.selectionStart ?? value.pending.length,
                  event.currentTarget.selectionEnd ?? value.pending.length,
                ),
              );
            }}
          />
          <button
            type="button"
            className="vocabulary-add-button"
            disabled={disabled || !hasPendingVocabulary(value.pending)}
            aria-label="Add term"
            onClick={() => add()}
          >
            <Plus size={18} aria-hidden="true" />
          </button>
        </div>
      </div>
      <p className="field-hint" id={`${id}-hint`}>
        Press Enter or comma to add. Paste a list to add several terms. Spaces
        stay within a phrase.
      </p>
      {value.error && (
        <p id={`${id}-error`} className="vocabulary-error" role="alert">
          {value.error}
        </p>
      )}
      <span className="sr-only" role="status">
        {value.announcement}
      </span>
    </section>
  );
}
