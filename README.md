# Twenty-Piece Rush

A browser puzzle game. A picture is cut into pieces and scrambled. Put every piece back in
its spot before the clock runs out. Pick Easy, Medium or Hard to change how many pieces you
get and how long you have.

**Play it:** https://siddharthmishra95.github.io/puzzle-game/

## How to play

1. Choose a difficulty under the title (see the table below).
2. Pick one of the built-in pictures, or upload your own photo.
3. Press **Scramble & start**. The picture breaks apart, the pieces land in the box,
   and the clock starts counting down.
4. Drag a piece onto the board. On touch screens you can also tap a piece, then tap a spot.
5. A piece only sticks in its correct spot. Dropping it in a wrong spot sends it back
   to the box and counts as a miss.
6. Place every piece before the clock reaches 00:00 to win. If time runs out, the
   missing pieces are shown faintly on the board.

| Difficulty | Grid  | Pieces | Time | Time per piece |
| ---------- | ----- | ------ | ---- | -------------- |
| Easy       | 4 × 3 | 12     | 4:00 | 20 seconds     |
| Medium     | 5 × 4 | 20     | 5:00 | 15 seconds     |
| Hard       | 6 × 5 | 30     | 6:00 | 12 seconds     |

Harder levels give more time in total, but less time for each piece. The game remembers
your last difficulty. You can't change difficulty or picture in the middle of a round:
pause or finish it first.

Other controls:

- **Pause** hides the pieces and stops the clock. The game also pauses when you switch tabs.
- **Restart** reshuffles the same picture and starts a new round at the same difficulty.
- Keyboard: Tab to a piece and press Enter to pick it up, use the arrow keys to move
  between board spots, and press Enter to place it. Escape puts the piece down.
- Your best time for each built-in picture and difficulty is saved in the browser.

## Live races

Race friends on the same picture and difficulty. Everyone gets the same shuffle and starts
together, a live scoreboard shows each player's progress, and the first to place every piece
wins.

Races need the small race server in this repo, because GitHub Pages only serves static files.
It uses only Node's built-in modules, so there is nothing to install (Node 18 or newer):

```sh
node server.js    # or: npm start
```

Then open http://localhost:3000.

1. Enter your name and press **Create a race**. You get a 4-letter race code.
2. Friends open the game from the same server, then enter the code and press **Join race**,
   or open the link from **Copy invite link**.
3. The host picks a built-in picture and a difficulty, and presses **Start race**. Everyone
   else sees the host's choice on their board. After a 3-second countdown, everyone gets the
   same scrambled pieces and one shared clock with that difficulty's time limit. Races can't
   be paused.
4. The scoreboard ranks finished players by time, then everyone else by pieces placed and
   fewest misses. The race ends when everyone finishes or the time runs out. The host can then
   start the next race.

**Playing on other computers:** your friends need to reach your server. On the same Wi-Fi,
share `http://<your computer's IP address>:3000`. Over the internet, deploy this repository
to a host that runs Node (for example Render, Railway or Fly.io) with `npm start` as the start
command.

**Storage:** race rooms are saved in `data/db.json`, which is created on first run and ignored
by git. It stands in for a database for now: rooms are deleted after 30 minutes without
activity, and many hosts wipe local files when they redeploy.

**Settings** (environment variables): `PORT` (default `3000`), `DB_FILE` (default
`data/db.json`), and `RACE_SECONDS`, which replaces every difficulty's time limit in races
(useful for quick test races; leave it unset to use the table above).

**Fair play:** the server times each finish with its own clock, but the piece counts come from
each player's browser, so a determined player could fake a finish. That's fine among friends;
a public leaderboard would need the server to check every move.

On GitHub Pages, or when you open `index.html` directly, the race panel is hidden and the
game is single-player.

## Running it

No build step and no dependencies. For single-player, open `index.html` in a browser or serve
the folder. For races, run `node server.js` (see above).

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
index.html      page markup
styles.css      layout, light and dark themes
script.js       game logic (slicing, drag and drop, timer, scoring)
multiplayer.js  race panel: rooms, countdown, live scoreboard
server.js       race server and static file server (Node, no dependencies)
assets/         built-in pictures (1200 × 960 SVG)
data/           race rooms (data/db.json), created by the server
```

## Customizing

- **Difficulty levels**: each level's grid and time limit are in the `LEVELS` table at the
  top of `script.js`. `server.js` has the same table for races; change both together. The
  number of columns in the box of loose pieces is set per level and screen size in
  `styles.css` (search for `--tray-cols`); pick a number that the piece count divides evenly.
- **More pictures**: add an image to `assets/` and an entry to the `PICTURES` list in
  `script.js`. Any size works; the game crops it to 5:4 from the center.
