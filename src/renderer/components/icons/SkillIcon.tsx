export function SkillIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      <path d="M4.5 7.5 11 2l8.5 2.5L13 10Z" fill="currentColor" />
      <path d="M4 11v6l8 4 8-4v-6M4 11l8 4 8-4M12 15v6" />
    </svg>
  )
}
