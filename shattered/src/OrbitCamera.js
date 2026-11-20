// The engine's orbit camera (EveCamera) with the field of view a host gives it, and seconds for time.
//
// EveCamera as Carbon wrote it does two things a host does not expect:
//   1. its default zoomCurve animates fieldOfView toward a wide EVE lens (set zoomCurve = null to stop it);
//   2. above an aspect ratio of 1.6 it narrows the picture (CalculateProjectionMatrix divides both half
//      extents by aspect / 1.6), so on a 16:9 view the vertical field of view is 0.9 of fieldOfView.
// OrbitCamera starts with no zoom curve and undoes the clamp, so fieldOfView is the vertical field of view at
// every aspect. Everything else (orbit, Dolly, RotateOnOrbit, friction, limits) is EveCamera's.
import { EveCamera } from "../../src/trinity/eve/camera/EveCamera.js";
import { CcpTime } from "../../src/blue/index.js";

/** EveCamera's wide-screen clamp (EveCamera.CalculateProjectionMatrix). */
const CLAMP_ASPECT = 1.6;

export class OrbitCamera extends EveCamera
{
  constructor()
  {
    super();
    this.zoomCurve = null;
    this.idleMove = false;
  }

  /**
   * EveCamera.Update with `fieldOfView` honoured as the vertical field of view at any aspect.
   *
   * @param {number} time Blue time (ticks): `CcpTime.timeFromDouble(seconds)`. `UpdateSeconds` takes seconds.
   * @param {number} [aspectRatio=1] Width over height of the view.
   * @param {number} [realTime=time] Real time in ticks.
   * @returns {boolean} Update's result.
   */
  Update(time, aspectRatio = 1, realTime = time)
  {
    const asked = this.fieldOfView;
    const wide = aspectRatio > CLAMP_ASPECT ? aspectRatio / CLAMP_ASPECT : 1;
    if (wide === 1) return super.Update(time, aspectRatio, realTime);
    // The clamp divides tan(fov / 2) by `wide`; hand it a lens that much wider.
    this.fieldOfView = 2 * Math.atan(Math.tan(asked * 0.5) * wide);
    try
    {
      return super.Update(time, aspectRatio, realTime);
    }
    finally
    {
      // A zoom curve, if one was set, moved fieldOfView itself: keep what it set.
      if (!this.zoomCurve) this.fieldOfView = asked;
    }
  }

  /**
   * `Update` with time in seconds.
   *
   * @param {number} seconds Simulation time in seconds.
   * @param {number} [aspectRatio=1] Width over height of the view.
   * @returns {boolean} Update's result.
   */
  UpdateSeconds(seconds, aspectRatio = 1)
  {
    return this.Update(CcpTime.timeFromDouble(seconds), aspectRatio);
  }

  /** `StableUpdate` (the far-from-origin view) with time in seconds. */
  StableUpdateSeconds(seconds, aspectRatio = 1)
  {
    return this.StableUpdate(CcpTime.timeFromDouble(seconds), aspectRatio);
  }
}
