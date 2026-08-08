"""Entry point: builds windgram profiles from the latest GDPS 15 km run."""

from .build import GDPS, run

if __name__ == "__main__":
    run(GDPS)
