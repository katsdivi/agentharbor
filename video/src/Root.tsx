import React from 'react';
import { Composition, Still } from 'remotion';
import { ProductFilm, T } from './Film';
import { Poster } from './Poster';
import { Soundtrack } from './Soundtrack';
import { FPS, H, W } from './theme';

/** The film with its soundtrack; ProductFilm itself stays silent so stills and the poster are unaffected. */
const FilmWithSound: React.FC = () => (
  <>
    <ProductFilm />
    <Soundtrack />
  </>
);

export const Root: React.FC = () => (
  <>
    <Composition id="ProductFilm" component={FilmWithSound} durationInFrames={T.total} fps={FPS} width={W} height={H} />
    <Still id="Poster" component={Poster} width={W} height={H} />
  </>
);
