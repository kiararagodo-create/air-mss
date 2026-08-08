import type { SensorSpec } from "../types";

export default function SensorSpecCard({ spec }: { spec: SensorSpec }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2 mb-2">
        <h4 className="text-sm font-semibold text-slate-900">{spec.displayName}</h4>
        <span className="text-[11px] font-medium px-2 py-0.5 rounded-md bg-teal-50 text-teal-700 whitespace-nowrap">
          {spec.model}
        </span>
      </div>
      <p className="text-xs text-slate-500 leading-relaxed mb-3">{spec.description}</p>
      <dl className="space-y-1 text-xs mb-3">
        <div className="flex gap-1">
          <dt className="font-medium text-slate-700 shrink-0">Gases Monitored:</dt>
          <dd className="text-slate-500">{spec.gasesMonitored}</dd>
        </div>
        <div className="flex gap-1">
          <dt className="font-medium text-slate-700 shrink-0">Sensing Range:</dt>
          <dd className="text-slate-500">{spec.sensingRange}</dd>
        </div>
        <div className="flex gap-1">
          <dt className="font-medium text-slate-700 shrink-0">Accuracy Rating:</dt>
          <dd className="text-slate-500">{spec.accuracyRating}</dd>
        </div>
      </dl>
      <p className="text-[11px] font-medium tracking-wide text-slate-400 mb-1.5">KEY SPECIFICATIONS</p>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
        {spec.keySpecs.map((s) => (
          <li key={s} className="text-xs text-slate-500 flex items-start gap-1.5">
            <span className="text-teal-500 mt-0.5">•</span>
            {s}
          </li>
        ))}
      </ul>
    </div>
  );
}