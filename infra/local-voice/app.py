import base64
import io
import json
import math
import os
import re
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import av
from fastapi import FastAPI, HTTPException
from faster_whisper import WhisperModel
from pydantic import BaseModel, Field
from pypdf import PdfReader


MAX_AUDIO_BYTES = 8 * 1024 * 1024
MAX_AUDIO_SECONDS = float(os.getenv("VOICE_MAX_SECONDS", "300"))
MAX_DOCUMENT_BYTES = 25 * 1024 * 1024
MAX_DOCUMENTS = 6
DOCUMENT_OLLAMA_URL = os.getenv("DOCUMENT_OLLAMA_URL", "http://host.docker.internal:11434/api/chat")
DOCUMENT_VISION_MODEL = os.getenv("DOCUMENT_VISION_MODEL", "qwen3.5:9b")
MIME_SUFFIXES = {
    "audio/aac": ".aac",
    "audio/amr": ".amr",
    "audio/mp4": ".m4a",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/opus": ".opus",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
}


class TranscriptionRequest(BaseModel):
    audio_base64: str = Field(min_length=4)
    mime_type: str = Field(min_length=3, max_length=120)
    sha256: str | None = Field(default=None, max_length=200)


class DocumentInput(BaseModel):
    content_base64: str = Field(min_length=4)
    mime_type: str = Field(min_length=3, max_length=120)
    file_name: str | None = Field(default=None, max_length=240)
    file_id: str | None = Field(default=None, max_length=100)


class PartnerFormExtractionRequest(BaseModel):
    documents: list[DocumentInput] = Field(min_length=1, max_length=MAX_DOCUMENTS)
    allow_vision: bool = True


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
model = WhisperModel(
    os.getenv("VOICE_MODEL", "base"),
    device="cpu",
    compute_type=os.getenv("VOICE_COMPUTE_TYPE", "int8"),
    cpu_threads=max(1, int(os.getenv("VOICE_CPU_THREADS", "4"))),
    download_root=os.getenv("HF_HOME", "/models"),
)
transcription_lock = threading.Lock()
document_vision_lock = threading.Lock()


FIELD_DEFINITIONS = {
    "shop_trading_name": ("Shop / trading name", "required"),
    "application_date": ("Application date", "optional"),
    "authorised_representative": ("Owner / authorised representative", "required"),
    "primary_mobile": ("Primary WhatsApp / mobile", "required"),
    "email_address": ("Email address", "optional"),
    "preferred_language": ("Preferred language", "optional"),
    "shop_address": ("Full shop address", "required"),
    "business_types": ("Business type", "required"),
    "business_type_other": ("Other business type", "conditional"),
    "legal_registered_name": ("Legal / registered name", "optional"),
    "registration_number": ("Registration number", "optional"),
    "vat_number": ("VAT number", "optional"),
    "business_structure": ("Independent / franchise / other", "optional"),
    "alternative_contact": ("Alternative contact", "optional"),
    "alternative_phone": ("Alternative telephone", "optional"),
    "products_services_description": ("Products or services sold", "required"),
    "retail_acknowledgements": ("Normal retail transaction acknowledgements", "required"),
    "trading_hours": ("Public trading hours", "required"),
    "closure_days": ("Regular closure days", "optional"),
    "closure_times": ("Regular closure times", "optional"),
    "closure_reason": ("Closure reason", "optional"),
    "closure_seasonal_notes": ("Seasonal closure notes", "optional"),
    "holiday_emergency_closures": ("Holiday / emergency closure arrangements", "optional"),
    "catalogue_supply": ("Catalogue material supplied", "optional"),
    "catalogue_file_formats": ("Catalogue file formats", "optional"),
    "catalogue_update_cadence": ("Catalogue update preference", "optional"),
    "applicant_name": ("Applicant name", "required"),
    "applicant_capacity": ("Applicant capacity / role", "required"),
    "applicant_signature": ("Applicant signature or typed name", "required"),
    "signature_date": ("Signature date", "required"),
}

BUSINESS_TYPES = {
    "business_type_1": "Grocery / supermarket / general dealer",
    "business_type_2": "Convenience / spaza",
    "business_type_3": "Butchery / fresh food",
    "business_type_4": "Bakery / restaurant / takeaway",
    "business_type_5": "Pharmacy / health and beauty",
    "business_type_6": "Hardware / building / agricultural / garden",
    "business_type_7": "Veterinary / pet supplies",
    "business_type_8": "Clothing / footwear / homeware",
    "business_type_9": "Automotive / spares",
    "business_type_10": "Electronics / appliances",
    "business_type_11": "Liquor outlet",
    "business_type_12": "Tobacco / nicotine retailer",
    "business_type_13": "Local producer / speciality shop",
    "business_type_14": "Other",
}

RETAIL_ACKS = {
    "retail_ack_1": "Getit may shop during the supplied public opening hours",
    "retail_ack_2": "Getit pays at the till as an ordinary retail customer",
    "retail_ack_3": "The shop issues its normal till receipt",
    "retail_ack_4": "The shop does not reserve stock or maintain live availability for Getit",
}

CATALOGUE_SUPPLY = {
    "catalogue_supply_1": "Specials flyer", "catalogue_supply_2": "Regular catalogue",
    "catalogue_supply_3": "Menu", "catalogue_supply_4": "Price list",
    "catalogue_supply_5": "Mixed catalogue and specials",
    "catalogue_supply_6": "No catalogue - shop on request only",
}

CATALOGUE_FILES = {
    "catalogue_file_1": "PDF", "catalogue_file_2": "JPG", "catalogue_file_3": "PNG",
    "catalogue_file_4": "WEBP", "catalogue_file_5": "CSV", "catalogue_file_6": "XLSX",
    "catalogue_file_7": "Other",
}

CATALOGUE_UPDATES = {
    "catalogue_update_1": "Weekly", "catalogue_update_2": "Fortnightly",
    "catalogue_update_3": "Monthly", "catalogue_update_4": "Quarterly",
    "catalogue_update_5": "On demand / whenever it changes",
}

SIMPLE_FIELDS = set(FIELD_DEFINITIONS) - {
    "business_types", "retail_acknowledgements", "trading_hours",
    "catalogue_supply", "catalogue_file_formats", "catalogue_update_cadence",
}

VISION_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "page_number": {"type": ["integer", "null"], "minimum": 1, "maximum": 5},
        "fields": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "field_key": {"type": "string", "enum": sorted(FIELD_DEFINITIONS)},
                    "value_text": {"type": ["string", "null"]},
                    "value_json": {},
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    "evidence_text": {"type": ["string", "null"]},
                },
                "required": ["field_key", "value_text", "value_json", "confidence", "evidence_text"],
            },
        },
    },
    "required": ["page_number", "fields"],
}

VISION_FIELDS_BY_PAGE = {
    1: ["shop_trading_name", "application_date", "authorised_representative", "primary_mobile",
        "email_address", "preferred_language", "shop_address"],
    2: ["business_types", "business_type_other", "legal_registered_name", "registration_number",
        "vat_number", "business_structure", "alternative_contact", "alternative_phone",
        "products_services_description", "retail_acknowledgements"],
    3: ["trading_hours", "closure_days", "closure_times", "closure_reason",
        "closure_seasonal_notes", "holiday_emergency_closures"],
    4: ["catalogue_supply", "catalogue_file_formats", "catalogue_update_cadence"],
    5: ["applicant_name", "applicant_capacity", "applicant_signature", "signature_date"],
}

VISION_REQUIRED_BY_PAGE = {
    1: ["shop_trading_name", "authorised_representative", "primary_mobile", "shop_address"],
    2: ["business_types", "products_services_description", "retail_acknowledgements"],
    3: ["trading_hours"],
    5: ["applicant_name", "applicant_capacity", "applicant_signature", "signature_date"],
}

VISION_PAGE_GUIDANCE = {
    1: (
        "Read the handwritten identity/contact block carefully, line by line. Map the trading or shop name, "
        "owner or authorised representative, mobile/WhatsApp number, and full operating address to their exact keys. "
        "A label may be printed faintly above or beside handwriting. Preserve spelling and digits; never guess an unreadable value."
    ),
    2: (
        "Inspect every marked checkbox as well as handwriting. For retail_acknowledgements return a JSON array containing "
        "only the visibly marked statements, even when fewer than all statements are marked."
    ),
    3: (
        "Read each weekday row separately. Preserve unclear or crossed-out times in the evidence instead of silently choosing one."
    ),
    4: (
        "Catalogue choices are optional. Return only visibly selected formats, cadence, or supply choices; an entirely blank page is valid."
    ),
    5: (
        "Inspect the agreement block closely. A visible handwritten signature, initials, or signature mark counts as "
        "applicant_signature with value_text 'Signature present'; do not try to identify a person from the signature."
    ),
}


def is_checked(value: Any) -> bool:
    return str(value or "").strip().lower() not in {"", "/off", "off", "false", "0", "none"}


def clean_text(value: Any) -> str:
    return " ".join(str(value or "").replace("\x00", " ").split()).strip()


def normalize_za_mobile(value: str) -> str:
    digits = re.sub(r"\D", "", value)
    if len(digits) == 9 and digits[0] in "678":
        return f"+27{digits}"
    if len(digits) == 10 and digits.startswith("0"):
        return f"+27{digits[1:]}"
    if len(digits) == 11 and digits.startswith("27"):
        return f"+{digits}"
    return value


def field_candidate(key: str, *, value_text: str | None = None, value_json: Any = None,
                    confidence: float, method: str, file_id: str | None,
                    page: int | None = None, evidence: str | None = None) -> dict:
    label, requirement = FIELD_DEFINITIONS[key]
    normalized_text = clean_text(value_text) or None
    if key == "primary_mobile" and normalized_text:
        normalized_text = normalize_za_mobile(normalized_text)
    if key in SIMPLE_FIELDS:
        value_json = None
    return {
        "field_key": key,
        "field_label": label,
        "requirement_level": requirement,
        "value_text": normalized_text,
        "value_json": None if value_json in (None, "", [], {}) else value_json,
        "confidence": round(max(0.0, min(1.0, float(confidence))), 4),
        "extraction_method": method,
        "source_file_id": file_id,
        "source_page": page,
        "evidence_text": clean_text(evidence)[:500] or None,
    }


def pdf_widget_pages(reader: PdfReader) -> dict[str, int]:
    pages: dict[str, int] = {}
    for page_index, page in enumerate(reader.pages, start=1):
        for annotation_ref in page.get("/Annots", []):
            annotation = annotation_ref.get_object()
            name = annotation.get("/T")
            if name:
                pages[str(name)] = page_index
    return pages


def extract_acroform(document: bytes, file_id: str | None) -> list[dict]:
    reader = PdfReader(io.BytesIO(document))
    fields = reader.get_fields() or {}
    pages = pdf_widget_pages(reader)
    results: list[dict] = []

    for key in sorted(SIMPLE_FIELDS):
        if key not in fields:
            continue
        value = clean_text(fields[key].get("/V"))
        if value and value.lower() not in {"/off", "off"}:
            results.append(field_candidate(
                key, value_text=value, confidence=1, method="acroform",
                file_id=file_id, page=pages.get(key), evidence=f"Form field: {key}",
            ))

    grouped = [
        ("business_types", BUSINESS_TYPES),
        ("retail_acknowledgements", RETAIL_ACKS),
        ("catalogue_supply", CATALOGUE_SUPPLY),
        ("catalogue_file_formats", CATALOGUE_FILES),
        ("catalogue_update_cadence", CATALOGUE_UPDATES),
    ]
    for result_key, mapping in grouped:
        selected = [label for source_key, label in mapping.items()
                    if source_key in fields and is_checked(fields[source_key].get("/V"))]
        if selected:
            results.append(field_candidate(
                result_key, value_text="; ".join(selected), value_json=selected,
                confidence=1, method="acroform", file_id=file_id,
                page=min((pages.get(source_key, 99) for source_key in mapping if source_key in fields), default=None),
                evidence="Checked form options",
            ))

    hours: dict[str, dict[str, str]] = {}
    for day in ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"):
        values = {}
        for part in ("opens", "closes", "notes"):
            source_key = f"hours_{day}_{part}"
            value = clean_text(fields.get(source_key, {}).get("/V"))
            if value:
                values[part] = value
        if values:
            hours[day] = values
    if hours:
        summary = "; ".join(
            f"{day.title()}: {value.get('opens', '')}-{value.get('closes', '')} {value.get('notes', '')}".strip()
            for day, value in hours.items()
        )
        results.append(field_candidate(
            "trading_hours", value_text=summary, value_json=hours, confidence=1,
            method="acroform", file_id=file_id, page=3, evidence="Public trading hours table",
        ))
    return results


def extract_image_with_vision(document: bytes, mime_type: str, file_id: str | None,
                              file_name: str | None) -> list[dict]:
    page_match = re.search(r"(?:page|pg)[-_ ]?([1-5])(?:\D|$)", file_name or "", re.IGNORECASE)
    page_hint = int(page_match.group(1)) if page_match else None
    allowed_keys = VISION_FIELDS_BY_PAGE.get(page_hint, list(FIELD_DEFINITIONS))
    allowed = ", ".join(f"{key} ({FIELD_DEFINITIONS[key][0]})" for key in allowed_keys)
    prompt = (
        "Read this single photographed page from the official five-page Getit Shop Participation and Catalogue Form. "
        "Extract only information visibly written, typed, ticked or signed by the applicant. Do not infer blanks, "
        "do not mark optional blanks as missing, and ignore the internal-only Getit representative and activation fields. "
        "For grouped answers use JSON arrays or objects. Evidence must be a short visual description, not invented text. "
    ) + (f"This is page {page_hint} of 5. " if page_hint else "") + (
        f"Allowed field keys for this page only: {allowed}. File hint: {file_name or 'none'}. "
        f"{VISION_PAGE_GUIDANCE.get(page_hint, '')}"
    )
    vision_schema = json.loads(json.dumps(VISION_SCHEMA))
    vision_schema["properties"]["fields"]["items"]["properties"]["field_key"]["enum"] = allowed_keys
    encoded_image = base64.b64encode(document).decode("ascii")

    def parse_content(content: Any) -> dict:
        if isinstance(content, dict):
            return content
        if not isinstance(content, str):
            raise ValueError("vision content is not JSON")
        candidate = content.strip()
        candidate = re.sub(r"^```(?:json)?\s*|\s*```$", "", candidate, flags=re.IGNORECASE)
        try:
            parsed_content = json.loads(candidate)
        except ValueError:
            start, end = candidate.find("{"), candidate.rfind("}")
            if start < 0 or end <= start:
                raise
            parsed_content = json.loads(candidate[start:end + 1])
        if not isinstance(parsed_content, dict) or not isinstance(parsed_content.get("fields"), list):
            raise ValueError("vision JSON shape is invalid")
        return parsed_content

    def request_vision(format_value: Any, request_prompt: str, predict: int) -> dict:
        body = json.dumps({
            "model": DOCUMENT_VISION_MODEL,
            "stream": False,
            "think": False,
            "format": format_value,
            "keep_alive": "30m",
            "options": {"temperature": 0, "seed": 42, "num_ctx": 8192, "num_predict": predict},
            "messages": [{"role": "user", "content": request_prompt, "images": [encoded_image]}],
        }).encode("utf-8")
        request = urllib.request.Request(
            DOCUMENT_OLLAMA_URL, data=body, method="POST",
            headers={"Content-Type": "application/json"},
        )
        with document_vision_lock, urllib.request.urlopen(request, timeout=180) as response:
            payload = json.loads(response.read().decode("utf-8"))
        return parse_content(payload.get("message", {}).get("content", ""))

    try:
        parsed = request_vision(vision_schema, prompt, 1800)
    except (ValueError, KeyError, TypeError):
        retry_prompt = prompt + (
            " Retry as one strict JSON object with keys page_number and fields. "
            "fields must be an array; return an empty array when nothing is filled in. No Markdown or commentary."
        )
        try:
            parsed = request_vision("json", retry_prompt, 1400)
        except (ValueError, KeyError, TypeError) as error:
            raise HTTPException(status_code=422, detail="local document vision returned invalid output") from error
        except (urllib.error.URLError, TimeoutError) as error:
            raise HTTPException(status_code=503, detail="local document vision unavailable") from error
    except (urllib.error.URLError, TimeoutError) as error:
        raise HTTPException(status_code=503, detail="local document vision unavailable") from error

    # Handwritten phone photos can be faint or skewed. A deterministic second
    # inspection is cheaper and safer than letting a missing first-pass field
    # silently become "not provided". It is still constrained to visible data
    # and is allowed to return an empty list when the applicant left it blank.
    if page_hint in VISION_REQUIRED_BY_PAGE:
        first_keys = {
            item.get("field_key") for item in parsed.get("fields", [])
            if isinstance(item, dict) and item.get("field_key") in allowed_keys
        }
        missing_keys = [key for key in VISION_REQUIRED_BY_PAGE[page_hint] if key not in first_keys]
        if missing_keys:
            recheck_prompt = (
                prompt
                + " Re-inspect the photographed page at full visual detail. The first inspection did not find these keys: "
                + ", ".join(missing_keys)
                + ". Return only fields among those keys that are visibly filled, checked, or signed. "
                  "Do not infer, complete, or guess any missing value. An empty fields array is correct for true blanks. "
                  "Return one strict JSON object with page_number and fields, with no Markdown."
            )
            try:
                rechecked = request_vision(vision_schema, recheck_prompt, 1800)
                parsed["fields"].extend(rechecked.get("fields", []))
            except (ValueError, KeyError, TypeError, urllib.error.URLError, TimeoutError):
                pass

    page = page_hint or parsed.get("page_number")
    results = []
    for item in parsed.get("fields", []):
        key = item.get("field_key")
        if key not in allowed_keys:
            continue
        value_text = clean_text(item.get("value_text")) or None
        value_json = item.get("value_json")
        if value_text is None and value_json in (None, "", [], {}):
            continue
        results.append(field_candidate(
            key, value_text=value_text, value_json=value_json,
            confidence=min(0.88, float(item.get("confidence", 0))), method="vision",
            file_id=file_id, page=page, evidence=item.get("evidence_text"),
        ))
    return results


def merge_candidates(candidates: list[dict]) -> list[dict]:
    chosen: dict[str, dict] = {}
    for candidate in candidates:
        key = candidate["field_key"]
        current = chosen.get(key)
        candidate_rank = (candidate["extraction_method"] == "acroform", candidate["confidence"])
        current_rank = ((current or {}).get("extraction_method") == "acroform", (current or {}).get("confidence", -1))
        if current is None or candidate_rank > current_rank:
            chosen[key] = candidate
    return [chosen[key] for key in FIELD_DEFINITIONS if key in chosen]


def inspect_duration(path: str) -> float:
    with av.open(path) as container:
        if container.duration is not None:
            return float(container.duration / av.time_base)
        audio_streams = [stream for stream in container.streams if stream.type == "audio"]
        if not audio_streams:
            raise ValueError("audio stream missing")
        stream = audio_streams[0]
        if stream.duration is None or stream.time_base is None:
            return 0.0
        return float(stream.duration * stream.time_base)


def transcribe(path: str) -> dict:
    with transcription_lock:
        segments, info = model.transcribe(
            path,
            beam_size=5,
            vad_filter=True,
            condition_on_previous_text=True,
        )
        materialized = list(segments)

    text = " ".join(segment.text.strip() for segment in materialized if segment.text.strip()).strip()
    average_log_probability = None
    if materialized:
        average_log_probability = sum(segment.avg_logprob for segment in materialized) / len(materialized)
    return {
        "ok": bool(text),
        "text": text[:4000],
        "language": info.language,
        "language_probability": round(float(info.language_probability), 6),
        "duration_seconds": round(float(info.duration), 3),
        "segment_count": len(materialized),
        "average_log_probability": (
            round(float(average_log_probability), 6)
            if average_log_probability is not None and math.isfinite(average_log_probability)
            else None
        ),
    }


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "voice_model": os.getenv("VOICE_MODEL", "base"),
        "document_vision_model": DOCUMENT_VISION_MODEL,
        "partner_form_extraction": True,
        "partner_form_extraction_version": 2,
    }


@app.post("/transcribe")
def transcribe_audio(payload: TranscriptionRequest) -> dict:
    mime_type = payload.mime_type.split(";", 1)[0].strip().lower()
    suffix = MIME_SUFFIXES.get(mime_type)
    if suffix is None:
        raise HTTPException(status_code=415, detail="unsupported audio type")
    try:
        audio = base64.b64decode(payload.audio_base64, validate=True)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="invalid base64 audio")
    if not audio or len(audio) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="audio size rejected")

    temporary_path = ""
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temporary:
            temporary.write(audio)
            temporary_path = temporary.name
        duration = inspect_duration(temporary_path)
        if duration <= 0 or duration > MAX_AUDIO_SECONDS:
            raise HTTPException(status_code=413, detail="audio duration rejected")
        return transcribe(temporary_path)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=422, detail="audio could not be transcribed")
    finally:
        if temporary_path:
            Path(temporary_path).unlink(missing_ok=True)


@app.post("/extract-partner-form")
def extract_partner_form(payload: PartnerFormExtractionRequest) -> dict:
    total_bytes = 0
    candidates: list[dict] = []
    document_results = []
    warnings = []
    for item in payload.documents:
        try:
            document = base64.b64decode(item.content_base64, validate=True)
        except (ValueError, TypeError):
            raise HTTPException(status_code=400, detail="invalid base64 document")
        total_bytes += len(document)
        if not document or total_bytes > MAX_DOCUMENT_BYTES:
            raise HTTPException(status_code=413, detail="document size rejected")

        mime_type = item.mime_type.split(";", 1)[0].strip().lower()
        extracted: list[dict]
        if mime_type == "application/pdf":
            try:
                extracted = extract_acroform(document, item.file_id)
            except Exception as error:
                raise HTTPException(status_code=422, detail="PDF form could not be read") from error
        elif mime_type in {"image/jpeg", "image/png", "image/webp"}:
            if not payload.allow_vision:
                extracted = []
            else:
                try:
                    extracted = extract_image_with_vision(document, mime_type, item.file_id, item.file_name)
                except HTTPException as error:
                    warnings.append({"file_id": item.file_id, "code": str(error.detail)[:160]})
                    document_results.append({
                        "file_id": item.file_id,
                        "file_name": item.file_name,
                        "mime_type": mime_type,
                        "candidate_count": 0,
                        "method": "vision",
                        "status": "needs_staff_review",
                        "error": str(error.detail)[:160],
                    })
                    continue
        else:
            raise HTTPException(status_code=415, detail="unsupported partner form document type")

        candidates.extend(extracted)
        document_results.append({
            "file_id": item.file_id,
            "file_name": item.file_name,
            "mime_type": mime_type,
            "candidate_count": len(extracted),
            "method": "acroform" if mime_type == "application/pdf" else "vision",
        })

    merged = merge_candidates(candidates)
    if not merged and warnings:
        raise HTTPException(status_code=422, detail="no application page could be extracted")
    return {
        "ok": True,
        "form_type": "getit_shop_participation_v2_1",
        "fields": merged,
        "documents": document_results,
        "field_count": len(merged),
        "partial": bool(warnings),
        "warnings": warnings,
        "requires_staff_review": True,
        "activation_authorized": False,
    }
