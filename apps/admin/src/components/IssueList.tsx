import type { Issue } from '@shared/types';

export default function IssueList({ errors = [], warnings = [] }: { errors?: Issue[]; warnings?: Issue[] }) {
  if (errors.length === 0 && warnings.length === 0) return <p className="text-sm text-green-700">ผ่านทุกกฎการวางแผน</p>;
  return (
    <ul className="space-y-1 text-sm">
      {errors.map((e, i) => (
        <li key={`e${i}`} className="rounded bg-red-50 px-2 py-1 text-red-800">
          <span className="font-mono text-xs">{e.code}</span> {e.message}
        </li>
      ))}
      {warnings.map((w, i) => (
        <li key={`w${i}`} className="rounded bg-amber-50 px-2 py-1 text-amber-800">
          <span className="font-mono text-xs">{w.code}</span> {w.message}
        </li>
      ))}
    </ul>
  );
}
