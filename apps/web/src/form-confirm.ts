export function shouldProceedWithConfirm(
  confirmMessage: string | undefined,
  confirm: () => boolean = () => true,
): boolean {
  if (!confirmMessage) {
    return true;
  }
  return confirm();
}
