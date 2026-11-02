import { mount } from './mount';
import { Placeholder, Shell } from './components';

mount(
  <Shell title="Tripwire">
    <Placeholder description="Assumptions behind this decision and their current values will appear here." />
  </Shell>,
);
