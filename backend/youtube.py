from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api._errors import (
    TranscriptsDisabled,
    NoTranscriptFound
)

from urllib.parse import urlparse, parse_qs


def extract_video_id(url: str) -> str:
    parsed_url = urlparse(url)

    if parsed_url.hostname in {"www.youtube.com", "youtube.com"}:
        if parsed_url.path == "/watch":
            video_id = parse_qs(parsed_url.query).get("v")

            if video_id:
                return video_id[0]


    if parsed_url.hostname == "youtu.be":
        video_id = parsed_url.path.strip("/")

        if video_id:
            return video_id

    raise ValueError("Invalid YouTube video URL.")

def get_transcript(video_id):

    youtube = YouTubeTranscriptApi()

    try:

        transcript_list = youtube.list(video_id)

        transcripts = list(transcript_list)

        if not transcripts:
            raise RuntimeError(
                "No transcripts are available for this video."
            )

        print("\nAVAILABLE TRANSCRIPTS")

        for transcript in transcripts:
            print(
                f"{transcript.language} "
                f"({transcript.language_code}) "
                f"| generated={transcript.is_generated}"
            )

        # Prefer a manually created transcript
        manual_transcripts = [
            transcript
            for transcript in transcripts
            if not transcript.is_generated
        ]

        if manual_transcripts:
            selected_transcript = manual_transcripts[0]

        else:
            # Otherwise use an automatically generated transcript
            selected_transcript = transcripts[0]

        print(
            "\nSELECTED TRANSCRIPT:",
            selected_transcript.language,
            f"({selected_transcript.language_code})"
        )

        print(
            "Generated:",
            selected_transcript.is_generated
        )

        return selected_transcript.fetch()

    except TranscriptsDisabled:

        raise RuntimeError(
            "Captions are disabled for this video."
        )

    except NoTranscriptFound:

        raise RuntimeError(
            "No transcript found for this video."
        )