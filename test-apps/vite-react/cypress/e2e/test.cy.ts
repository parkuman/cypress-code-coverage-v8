it("should pass", () => {
  cy.visit("/");
  cy.get("button").first().click();
});
