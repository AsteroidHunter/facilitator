# Update steps

`facilitator update` pulls the checkout forward, then runs the steps in this
folder that have not run on that checkout yet. A step is for a change that a
`git pull` and a `.venv` sync cannot make alone, such as installing a tool.

- Name a step `NNNN-what-it-does.sh` or `NNNN-what-it-does.py`, with four
  digits. Steps run in name order, so the next free number goes on a new one.
  Files here with any other name are ignored.
- Each step runs once per checkout. The name goes into
  `.facilitator-updates.json` beside the checkout (gitignored) when the step
  exits with status 0. Never rename or edit a step that has shipped; add a new
  one.
- A step that exits with another status stops the update, is not recorded, and
  runs again on the next `facilitator update`. Later steps wait behind it.
- Steps run from the checkout folder with no input, so they cannot ask
  questions. `.sh` steps run under bash, `.py` steps under the board's `.venv`
  python. Their output goes straight to the terminal.
- A checkout that has never recorded a step runs every step here, including
  ones from before it was installed. Write each step so it is harmless on a
  machine that already has the result, and have it check before it changes
  anything.
