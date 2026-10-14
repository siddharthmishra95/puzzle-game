# Twenty-Piece Rush

A browser puzzle game. A picture is cut into 20 pieces (a 5 × 4 grid) and scrambled.
Put every piece back in its spot before the 5-minute clock runs out.

**Play it:** https://siddharthmishra95.github.io/puzzle-game/

## How to play

1. Pick one of the built-in pictures, or upload your own photo.
2. Press **Scramble & start**. The picture breaks apart, the pieces land in the box,
   and the clock starts counting down from 5:00.
3. Drag a piece onto the board. On touch screens you can also tap a piece, then tap a spot.
4. A piece only sticks in its correct spot. Dropping it in a wrong spot sends it back
   to the box and counts as a miss.
5. Place all 20 pieces before the clock reaches 00:00 to win. If time runs out, the
   missing pieces are shown faintly on the board.

Other controls:

- **Pause** hides the pieces and stops the clock. The game also pauses when you switch tabs.
- **Restart** reshuffles the same picture and starts a new 5-minute round.
- Keyboard: Tab to a piece and press Enter to pick it up, use the arrow keys to move
  between board spots, and press Enter to place it. Escape puts the piece down.
- Your best time for each built-in picture is saved in the browser.

## Running it

No build step and no dependencies. Open `index.html` in a browser, or serve the folder:

```sh
npx serve .
# or
python3 -m http.server 8000
```

## Hosting on GitHub Pages

The game is plain static files, so GitHub Pages can serve it directly. In the repository,
go to **Settings → Pages**, set **Source** to **Deploy from a branch**, pick the branch and
the `/ (root)` folder, and save. The `.nojekyll` file tells Pages to serve the files as-is.

## Project layout

```
index.html   page markup
styles.css   layout, light and dark themes
script.js    game logic (slicing, drag and drop, timer, scoring)
assets/      built-in pictures (1200 × 960 SVG)
```

## Customizing

- **Grid size and time limit**: change `COLS`, `ROWS` and `TIME_LIMIT_MS` at the top of
  `script.js`. Also update the grid in `styles.css` (`.board` uses `repeat(5, 1fr)` columns,
  `repeat(4, 1fr)` rows and `aspect-ratio: 5 / 4`).
- **More pictures**: add an image to `assets/` and an entry to the `PICTURES` list in
  `script.js`. Any size works; the game crops it to 5:4 from the center.
