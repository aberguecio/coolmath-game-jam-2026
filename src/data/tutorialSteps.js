// Tutorial step registry. The overlay reads this list and walks through each step.
// A step closes when its `gate(state)` returns true OR when the user clicks Next.
// `gate` returning false (constant) means: only manual Next advances it.

export const TUTORIAL_STEPS = [
  {
    id: 'welcome',
    title: 'Welcome to Farm Tycoon',
    body:
      'You start with $0 and one fallow tile. To do anything you need money. ' +
      "Don't worry — banks lend money to people with land.",
    gate: () => false,
    highlight: null,
  },
  {
    id: 'open_bank',
    title: 'Open the Bank',
    body: 'Click the BANK button on the top bar. We will take a small loan to get going.',
    gate: (state) => state.tutorial.bankOpened === true,
    highlight: 'bankButton',
  },
  {
    id: 'take_loan',
    title: 'Take a Working Capital loan',
    body:
      'Pick "Working Capital" and confirm $5,000 at 24% APR over 12 months. ' +
      'Use the cash to plow & plant your starter tile.',
    gate: (state) => (state.loans ?? []).some(l => l.borrowerId === 'player'),
    highlight: 'bankModal',
  },
  {
    id: 'plow_plant',
    title: 'Work the land',
    body:
      'Click your tile (center of the map, golden border). Plow it ($50), then plant Wheat ($200). ' +
      'It needs ~90 days to mature. Use the speed buttons to fast-forward.',
    gate: (state) => state.maps.home.tiles.some(
      t => t.owner === 'player' && (t.state === 'planted' || t.state === 'mature'),
    ),
    highlight: 'tile',
  },
  {
    id: 'watch_market',
    title: 'Watch the global market',
    body:
      'Right side shows live prices and inventory. Countries (USA, China, Brazil, Germany) buy daily ' +
      'based on their preferences and budget. Surplus drops prices; shortages spike them.',
    gate: () => false,
    highlight: 'marketPanel',
  },
  {
    id: 'expand',
    title: 'Expand your operation',
    body:
      'Click any wild tile to buy it — pay cash OR finance through the bank. ' +
      'Land mortgages have lower rates than working capital. Diversify crops and good luck.',
    gate: () => false,
    highlight: null,
  },
];
