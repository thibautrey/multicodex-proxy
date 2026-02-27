import React from "react";

export function Metric({ title, value }: { title: string; value: string }) {
  return (
    <div className="panel metric">
      <div className="muted metric-title">{title}</div>
      <div className="value">{value}</div>
    </div>
  );
}
