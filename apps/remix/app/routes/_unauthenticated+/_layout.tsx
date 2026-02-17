import { Outlet } from 'react-router';

export default function Layout() {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center bg-white px-4 py-12 text-[#302f2e] md:p-12 lg:p-24">
      <div className="relative w-full">
        <Outlet />
      </div>
    </main>
  );
}
