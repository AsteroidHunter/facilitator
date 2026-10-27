/* The shared worker that holds the board's one live line for every board
   window of this browser (board-line.js says why one line, and what a window
   does with what it hears). Each window says hello when it opens and bye when
   it goes; the worker tells each one every line the board writes and whenever
   the line is down. */
importScripts("/board-line.js");
BoardLine.worker(self);
