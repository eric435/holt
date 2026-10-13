// Fills the home page with enough content to make it several screens tall,
// so full-page screenshots (scroll + stitch) have real work to do.

const features = [
  ["Fast", "Loads before you finish blinking. Mostly."],
  ["Accessible", "Keyboard friendly, screen-reader tested, contrast checked."],
  ["Private", "Your data stays on your machine, like your QA notes."],
  ["Typed", "TypeScript all the way down, until it isn't."],
  ["Tested", "Unit tests, integration tests, and now holt sessions."],
  ["Documented", "Every option explained, some of them twice."],
];

const cards = document.querySelector<HTMLElement>("#features");
if (cards) {
  cards.innerHTML = '<h2>Features</h2><div class="grid"></div>';
  const grid = cards.querySelector(".grid");
  for (let i = 0; i < 3; i++) {
    for (const [title, text] of features) {
      const card = document.createElement("article");
      card.className = "card";
      card.innerHTML = `<h3></h3><p></p>`;
      card.querySelector("h3")!.textContent = `${title} ${i + 1}`;
      card.querySelector("p")!.textContent = text ?? "";
      grid?.append(card);
    }
  }
}

const faqs = [
  "Can I cancel any time?",
  "Do you offer refunds?",
  "Is there a student discount?",
  "Where is my data stored?",
  "Can I change plans later?",
  "Do you support SSO?",
  "What happens when my trial ends?",
  "How do I contact support?",
];

const faqList = document.querySelector("#faq-list");
for (const question of faqs) {
  const details = document.createElement("details");
  details.innerHTML = "<summary></summary><p></p>";
  details.querySelector("summary")!.textContent = question;
  details.querySelector("p")!.textContent =
    "Yes, probably. This answer is placeholder text, long enough to wrap onto a second line on narrow screens.";
  faqList?.append(details);
}
