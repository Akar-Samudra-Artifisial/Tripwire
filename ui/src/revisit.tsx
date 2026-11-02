import { mount } from './mount';
import { Placeholder, Shell } from './components';

mount(
  <Shell title="Decision revisit">
    <Placeholder description="The original decision, the tripped assumption, its evidence and the work built on it." />
  </Shell>,
);
