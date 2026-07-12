import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-[#07090d] text-slate-100">
      <h1 className="text-xl font-semibold tracking-tight">Event Not Found</h1>
      <p className="text-sm text-slate-400">
        No scored event exists for that ID. It may have expired or the link is wrong.
      </p>
      <Link href="/" className="text-sm text-red-400 hover:text-red-300">
        Back To The Wall
      </Link>
    </main>
  );
}
