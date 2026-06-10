'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type SpeechValueSetter = (value: string | ((current: string) => string)) => void;

interface SpeechRecognitionAlternativeLike {
  readonly transcript: string;
}

interface SpeechRecognitionResultLike {
  readonly length: number;
  readonly isFinal: boolean;
  item(index: number): SpeechRecognitionAlternativeLike;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionResultListLike {
  readonly length: number;
  item(index: number): SpeechRecognitionResultLike;
  [index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  start(): void;
  stop(): void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

interface SpeechRecognitionWindow extends Window {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

export function useSpeechInput({
  disabled,
  setValue,
  value,
}: {
  readonly disabled?: boolean;
  readonly setValue: SpeechValueSetter;
  readonly value: string;
}) {
  const baseValueRef = useRef('');
  const valueRef = useRef(value);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const [listening, setListening] = useState(false);
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    setSupported(Boolean(speechRecognitionConstructor()));
  }, []);

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
      recognitionRef.current = null;
    };
  }, []);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setListening(false);
  }, []);

  const toggle = useCallback(() => {
    if (disabled) {
      return;
    }
    if (recognitionRef.current) {
      stop();
      return;
    }
    const Recognition = speechRecognitionConstructor();
    if (!Recognition) {
      setSupported(false);
      return;
    }
    const recognition = new Recognition();
    baseValueRef.current = valueRef.current;
    recognition.lang = 'ja-JP';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      setValue(appendSpeechTranscript(baseValueRef.current, speechTranscript(event.results)));
    };
    recognition.onerror = () => {
      recognitionRef.current = null;
      setListening(false);
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setListening(false);
    };
    recognitionRef.current = recognition;
    setListening(true);
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setListening(false);
    }
  }, [disabled, setValue, stop]);

  return { listening, supported, toggle };
}

export function appendSpeechTranscript(value: string, transcript: string): string {
  const trimmedTranscript = transcript.trim();
  if (!trimmedTranscript) {
    return value;
  }
  const separator = value.trim().length > 0 && !/\s$/u.test(value) ? ' ' : '';
  return `${value}${separator}${trimmedTranscript}`;
}

function speechTranscript(results: SpeechRecognitionResultListLike): string {
  const transcripts: string[] = [];
  for (let index = 0; index < results.length; index += 1) {
    transcripts.push(results[index]?.[0]?.transcript ?? '');
  }
  return transcripts.join('');
}

function speechRecognitionConstructor(): SpeechRecognitionConstructor | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  const speechWindow = window as SpeechRecognitionWindow;
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
}
