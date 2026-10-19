# Searching cards and messages

The board can search every card and every message on it: each card's title, what you sent, the agent's replies, its notes and its progress notes. It can also list cards by their details alone, such as the cards made during a date range. On the Mac board, the magnifier in the top bar opens a search panel over this (see [Searching the cards](board.md#searching-the-cards)); this page is about the search itself, which the board answers at `GET /search`.

## How it works

The search reads an index the board keeps in `data/search-index.sqlite`, beside `state.json` and `transcript.jsonl`, which it is built from. A thread of the board's own keeps it current: after each change the board saves, it waits half a second for more changes to land and then reads what is new. A first build of a board with about 1,000 cards and 30,000 messages takes a few seconds, and the board answers as usual while it runs.

It searches two ways:

- **By the words**, always. This is SQLite's full-text search, which the board's Python has built in. Words match their other forms ("searching" finds "search"), every word you type must be in the same message, with the card's title counting as part of each of its messages, and when no message has them all, a message with any of them is found. Put words in double quotes to find them together, in that order.
- **By meaning**, once a model for it is set up (below). The model is EmbeddingGemma 2, which runs on this Mac. It finds a message about a car when you search for "automobile". With the model ready, every search uses both ways at once and ranks a card higher when both find it.

A card in the Bin is searched only when a search asks for the Bin. A card deleted for good leaves the index with everything it held.

## The search route

`GET /search` takes:

| Name | What it does |
| :--- | :--- |
| `q` | The words to search for. Without it, the answer lists the cards the filters allow, newest first. |
| `lane` | Only these lanes (the lane's id, as in `run.config.json`). Repeat it or separate with commas. |
| `section` | Only these sections: `doing`, `docked`, `deferred`, `done`, `bin`. Without it, every section but the Bin. |
| `from`, `to` | A date range: a day (`2026-09-01`, read in this Mac's time zone, with `to` taking the whole day), a time (`2026-09-01T09:30`, or with its own offset) or seconds since 1970. |
| `date` | What the range is on: `created` (when the card was made, the default), `changed` (when anything last happened on it) or `message` (the messages' own times). |
| `sort` | `relevance` (the default with words), `created` or `changed`, newest first. |
| `mode` | `auto` (the default: by words and meaning when the model is ready, by words when not), `keyword`, `semantic` or `hybrid`. |
| `prefix` | `1` lets the last word match the start of longer words, for a box that searches as you type. |
| `limit`, `offset` | Up to 100 results a page (20 by default), and where the page starts. |

For example, the cards made in September that mention the fence, and every card in the `garden` lane changed since October:

```sh
curl -s 'http://127.0.0.1:8877/search?q=fence&from=2026-09-01&to=2026-09-30'
curl -s 'http://127.0.0.1:8877/search?lane=garden&date=changed&from=2026-10-01'
```

Each result names the card (`card`, `title`, `lane`, `section`, `created`, `changed`, times in seconds), how it was found (`score`, `mode`, `ranks`, `similarity`) and the message that matched (`match`: its `kind`, `ts` and a `snippet` of plain text, with `marks` giving where each matched word starts and ends in it). The answer says which way it searched in `mode`, and in `fallback` why, when it could not search the way it was asked.

`GET /search/status` says whether the index is built, how much it holds, and where the search by meaning stands: `off` (no model set up), `loading`, `ready` or `unavailable`, with the reason. `embedded` and `waiting` count the pieces of text the model has read and has still to read.

## Switching on the search by meaning

The board needs two things: the model, run by one of the three programs below, and numpy, which holds the model's answers. Neither is part of the board's own install, and the board runs as before without them.

The board's optional packages go into `data/search-packages`, a folder of their own: `facilitator update` keeps `data/.venv` to exactly what the board itself needs, and leaves this folder alone. Run every command below from the top of the checkout.

### With Ollama (recommended)

Ollama runs the model in its own app, so the board itself stays small.

1. Install Ollama from [ollama.com](https://ollama.com) and fetch the model's text part (304 MB):

   ```sh
   ollama pull embeddinggemma-2:270m-q8_0-text
   ```

   `embeddinggemma-2:270m-bf16-text` (574 MB) is the same model unquantized, a little more exact.

2. Install numpy for the board:

   ```sh
   uv pip install --python data/.venv/bin/python --target data/search-packages \
       --require-hashes -r app/requirements-search.txt
   ```

3. Name the model in `data/run.config.json`, beside what is already there:

   ```json
   "search": {"embedder": "ollama", "model": "embeddinggemma-2:270m-q8_0-text", "dims": 512}
   ```

4. Restart the board with `facilitator restart`, and check `curl -s http://127.0.0.1:8877/search/status`: `semantic.state` turns `ready`, and `waiting` counts down to 0 as the model reads the board, newest first. Searches use the model as soon as it is ready, for what it has read so far.

Ollama answers at `http://127.0.0.1:11434`; name another port with `"url"`. If Ollama is not running, the board searches by words and tries the model again every minute.

### With llama.cpp

Start llama.cpp's server with the model's GGUF file and embeddings on:

```sh
llama-server -hf ggml-org/embeddinggemma-2-GGUF --embeddings
```

Install numpy as in step 2 above, then name it in `data/run.config.json`, with the port the server says it listens on (9931 unless told otherwise):

```json
"search": {"embedder": "openai", "url": "http://127.0.0.1:9931", "model": "embeddinggemma-2", "dims": 512}
```

`openai` is the kind of interface the server offers (`/v1/embeddings`), which LM Studio offers too; nothing is sent anywhere but this Mac.

### Inside the board, with sentence-transformers

This runs the model in the board's own process, which then needs roughly 1 to 2 GB more memory, and the model takes some seconds to load after each restart. torch needs macOS 14 or newer.

1. Install the packages, several hundred megabytes of them with torch:

   ```sh
   uv pip install --python data/.venv/bin/python --target data/search-packages \
       numpy==2.5.4 sentence-transformers==6.1.0 "transformers>=5.19.0,<6" torch==2.14.1
   ```

2. Fetch the model (1.5 GB) into the Hugging Face cache; the board never downloads it itself:

   ```sh
   uvx --from huggingface_hub hf download google/embeddinggemma-2
   ```

3. Name it in `data/run.config.json`:

   ```json
   "search": {"embedder": "sentence-transformers", "model": "google/embeddinggemma-2", "dims": 512}
   ```

   `"model"` may also name a folder the model was downloaded to. `"dtype": "bfloat16"` halves the memory; the default is `float32`. Never use float16, which breaks this model without an error.

4. Restart the board and check `/search/status` as in step 4 above.

### Changing or switching off

`"dims"` is how much of each of the model's answers is kept: 512 is the recommended size, and 768, 256 and 128 work too. Changing the model or `"dims"` has the model read the whole board again, in the background.

To switch the model off, remove the `"search"` entry or set `"embedder": "none"`, and restart. What the model read stays in the index, so switching the same model back on starts where it left off.

## What stays on the Mac

The index holds the cards' words, so like the files it is built from, only your Mac account can read it. The model runs on this Mac: the board sends text only to a model at a `127.0.0.1` or `localhost` address and refuses any other. The board's log notes that the index was built or the model loaded, never a word of a card, a message or a search.

Deleting `data/search-index.sqlite` is safe: the board builds it again. Deleting `data/search-packages` switches the search by meaning off until the packages are installed again.
