import React, { useState, useRef, useEffect } from "react";
import type { ExposedModel } from "../../types";

type Props = {
  models: ExposedModel[];
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
};

export function ModelSelector({ models, value, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Sync query with selected value when dropdown is closed
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  // Focus input when dropdown opens
  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const filtered = query
    ? models.filter((m) => m.id.toLowerCase().includes(query.toLowerCase()))
    : models;

  const handleSelect = (id: string) => {
    onChange(id);
    setOpen(false);
    setQuery("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="model-selector" ref={containerRef}>
      {/* Trigger button / input hybrid */}
      <div
        className="model-selector-trigger"
        onClick={() => !disabled && setOpen((o) => !o)}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
      >
        {open ? (
          <input
            ref={inputRef}
            className="model-selector-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            placeholder="Search models..."
            disabled={disabled}
            aria-label="Search models"
          />
        ) : (
          <span className="model-selector-value">{value || "Select a model..."}</span>
        )}
        <span className={`model-selector-arrow${open ? " open" : ""}`}>&#9662;</span>
      </div>

      {/* Dropdown list */}
      {open && !disabled && (
        <ul
          className="model-selector-list"
          role="listbox"
          onKeyDown={handleKeyDown}
        >
          {filtered.length === 0 ? (
            <li className="model-selector-empty">No models found</li>
          ) : (
            filtered.map((model) => (
              <li
                key={model.id}
                className={`model-selector-item${model.id === value ? " selected" : ""}`}
                onClick={() => handleSelect(model.id)}
                role="option"
                aria-selected={model.id === value}
              >
                <span className="model-selector-id">{model.id}</span>
                {model.metadata?.provider && (
                  <span className="model-selector-provider">{model.metadata.provider}</span>
                )}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
