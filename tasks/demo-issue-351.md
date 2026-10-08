# #351: the agent's goal verdict describes the final page

*2026-10-08T17:01:29Z by Showboat 0.6.1*
<!-- showboat-id: 48173833-9ce1-425e-b9a7-a16cdd40424e -->

Real CLI (`iris run --agent --json`, ts-node over src/cli.ts), real Chromium. The model is a scripted fake Ollama on 127.0.0.1:47351 (it also serves the page: a cart with **Pay now** and a **Log out** button that replaces the body with 'Logged out'). 'Before' is a worktree of main; 'after' is this branch. run351.sh scripts the plans and prints the verdict fields. Paths are shown as `$REPO` (this checkout) and `$SCRATCH` (a scratch dir holding the main worktree and the fixture).

## Criterion 1: a check acted past on a later turn is not a verdict
Turn 1: click Pay, check 'Your cart' (passes). Turn 2: click Log out. The cart is gone, and main still reports success.

```bash
$SCRATCH/run351.sh $SCRATCH/main-wt '[[{"type":"click","selector":"#pay"},{"type":"assert","kind":"text_visible","target":"Your cart"}],[{"type":"click","selector":"#away"}]]'
```

```output
goalMet: true  terminationReason: max_turns  status: success
actions: click #pay -> assert Your cart -> click #away
```

```bash
$SCRATCH/run351.sh $REPO '[[{"type":"click","selector":"#pay"},{"type":"assert","kind":"text_visible","target":"Your cart"}],[{"type":"click","selector":"#away"}]]'
```

```output
goalMet: null  terminationReason: max_turns  status: error
actions: click #pay -> assert Your cart -> click #away
```

## Criterion 2: the same, within one turn (check, then act)

```bash
$SCRATCH/run351.sh $SCRATCH/main-wt '[[{"type":"assert","kind":"text_visible","target":"Your cart"},{"type":"click","selector":"#away"}]]' 1
```

```output
goalMet: true  terminationReason: max_turns  status: success
actions: assert Your cart -> click #away
```

```bash
$SCRATCH/run351.sh $REPO '[[{"type":"assert","kind":"text_visible","target":"Your cart"},{"type":"click","selector":"#away"}]]' 1
```

```output
goalMet: null  terminationReason: max_turns  status: error
actions: assert Your cart -> click #away
```

## Criterion 3: unchanged where the check is the last thing: act, check, then a bare confirming check ends goal_met

```bash
$SCRATCH/run351.sh $REPO '[[{"type":"click","selector":"#pay"},{"type":"assert","kind":"text_visible","target":"Your cart"}],[{"type":"assert","kind":"text_visible","target":"Your cart"}]]'
```

```output
goalMet: true  terminationReason: goal_met  status: success
actions: click #pay -> assert Your cart -> assert Your cart
```

## Criterion 4: a policy-refused action never ran, so it does not clear the verdict

```bash
$SCRATCH/run351.sh $REPO '[[{"type":"click","selector":"#pay"},{"type":"assert","kind":"text_visible","target":"Your cart"}],[{"type":"click","selector":"#delete-account"}]]'
```

```output
goalMet: true  terminationReason: max_turns  status: success
actions: click #pay -> assert Your cart -> click #delete-account (failed) (refused)
```
