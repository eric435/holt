// A small checkout form with a couple of deliberate rough edges worth
// capturing with holt:
//  - the coupon field accepts whitespace-only input;
//  - the seat stepper does not clamp to min/max when clicked quickly.

const PRICES: Record<string, number> = { Hobby: 0, Team: 12, Enterprise: 40 };

const form = document.querySelector<HTMLFormElement>("#checkout-form");
const total = document.querySelector<HTMLElement>("#total");
const result = document.querySelector<HTMLElement>("#result");

function updateTotal(): void {
  if (!form || !total) return;
  const data = new FormData(form);
  const price = PRICES[String(data.get("plan"))] ?? 0;
  const seats = Number(data.get("seats")) || 0;
  total.textContent = `$${(price * seats).toFixed(2)}`;
}

form?.addEventListener("input", updateTotal);

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-step]")) {
  button.addEventListener("click", () => {
    const seats = form?.elements.namedItem("seats") as HTMLInputElement | null;
    if (!seats) return;
    seats.value = String(Number(seats.value) + Number(button.dataset.step));
    updateTotal();
  });
}

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!result) return;
  const data = new FormData(form);
  if (!data.get("terms")) {
    result.textContent = "Please accept the terms.";
    return;
  }
  const coupon = String(data.get("coupon") ?? "");
  result.textContent = coupon
    ? `Order placed with coupon "${coupon}" (not really).`
    : "Order placed (not really).";
});

updateTotal();
