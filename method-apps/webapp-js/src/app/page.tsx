import { MethodPage } from "@/components/MethodPage";
import { SITE } from "@/site";

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900">{SITE.title}</h1>
        <p className="mt-2 text-sm text-slate-600">{SITE.description}</p>
      </header>
      <MethodPage />
    </main>
  );
}
