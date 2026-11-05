export function scrollToSection(id: string): void {
  const element = document.getElementById(id);
  if (!element) return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  element.scrollIntoView({
    behavior: reduceMotion ? 'auto' : 'smooth',
    block: 'start',
  });
}
