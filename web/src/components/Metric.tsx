import React from "react";

type Props = {
  title: string;
  value: string;
  detail?: string;
  tone?: "default" | "success" | "warning" | "danger";
};

export function Metric({ title, value, detail, tone = "default" }: Props) {
  return (
    <div className={`panel metric metric-${tone}`}>
      <div className="muted metric-title">{title}</div>
      <div className="value">{value}</div>
      {detail && <div className="metric-detail">{detail}</div>}
    </div>
  );
}
